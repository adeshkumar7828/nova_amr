#!/usr/bin/env python3
"""
scan_to_server - hands Nova's LiDAR scan to the Nova server, 10 times a second.

  /scan (sensor_msgs/LaserScan)  ->  360 one-degree bins in NOVA's frame  ->  POST /api/lidar

  bins[i] = closest return in cm at i degrees (0 = straight ahead, 90 = left, 270 = right),
            0 = nothing seen. The server's Safe drive + Auto forward use them.

Parameters:
  server          'auto' (default) = http://localhost:8090, else the Windows host from WSL
  yaw_offset_rad  LiDAR mounting rotation. 3.14159 = arrow facing Nova's front
                  (the Slamtec driver's 0 deg is opposite the arrow)
  rate_hz         10

When /scan stops, the last bins keep being sent with a growing ageMs, so the server
can tell "LiDAR stopped" apart from "path clear".
"""
import json
import math
import subprocess
import urllib.request
import urllib.error

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan


def scan_to_bins(scan, yaw):
    bins = [0] * 360
    for i, r in enumerate(scan.ranges):
        if not math.isfinite(r) or r < scan.range_min or r > scan.range_max:
            continue
        deg = math.degrees(scan.angle_min + i * scan.angle_increment + yaw)
        b = int(round(deg)) % 360
        cm = int(round(r * 100))
        if cm > 0 and (bins[b] == 0 or cm < bins[b]):
            bins[b] = cm
    return bins


def reachable(url):
    try:
        urllib.request.urlopen(url + '/api/status', timeout=1).close()
        return True
    except Exception:
        return False


def find_server(arg):
    if arg != 'auto':
        return arg
    cands = ['http://localhost:8090']
    try:
        gw = subprocess.run(['ip', 'route'], capture_output=True, text=True, timeout=2).stdout
        for line in gw.splitlines():
            if line.startswith('default'):
                cands.append('http://%s:8090' % line.split()[2])
                break
    except Exception:
        pass
    for c in cands:
        if reachable(c):
            return c
    return None


class ScanToServer(Node):
    def __init__(self):
        super().__init__('scan_to_server')
        self.server_arg = self.declare_parameter('server', 'auto').value
        self.yaw = float(self.declare_parameter('yaw_offset_rad', 3.14159).value)
        rate = float(self.declare_parameter('rate_hz', 10.0).value)
        self.url = None
        self.bins = None
        self.scan_at = None
        self.warned = ''
        self.create_subscription(LaserScan, '/scan', self.on_scan, qos_profile_sensor_data)
        self.create_timer(1.0 / rate, self.send)
        self.get_logger().info(f'/scan -> Nova server (yaw offset {math.degrees(self.yaw):.0f} deg)')

    def warn_once(self, text):
        if text != self.warned:
            self.get_logger().warn(text)
            self.warned = text

    def on_scan(self, msg):
        self.bins = scan_to_bins(msg, self.yaw)
        self.scan_at = self.get_clock().now()

    def send(self):
        if self.bins is None:
            return
        if self.url is None:
            base = find_server(self.server_arg)
            if not base:
                return self.warn_once("can't reach the Nova server (is 'npm start' running on Windows?)")
            self.url = base + '/api/lidar'
            self.get_logger().info(f'sending scans to {self.url}')
        age_ms = int((self.get_clock().now() - self.scan_at).nanoseconds / 1e6)
        body = json.dumps({'bins': self.bins, 'ageMs': age_ms, 'source': 'ros'}, separators=(',', ':')).encode()
        try:
            req = urllib.request.Request(self.url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req, timeout=0.3).close()
            if self.warned:
                self.get_logger().info('Nova server is taking the scans')
                self.warned = ''
        except urllib.error.HTTPError as e:
            if e.code == 409:
                self.warn_once('Nova page is on "Laptop (direct)": switch LiDAR link to "ROS"')
            else:
                self.warn_once(f'Nova server answered {e.code}')
        except Exception as e:
            self.warn_once(f'cannot reach the Nova server ({e}); will keep trying')
            self.url = None


def main():
    rclpy.init()
    node = ScanToServer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
