"""
Nova: LiDAR over Wi-Fi + Nova's outline + RViz (+ scan to the Nova server).

    ros2 launch nova_bringup lidar.launch.py

  starts these NODES:
    nova_lidar_link   Wi-Fi link to the LiDAR bridge on Nova's ESP32 -> /tmp/ttyNOVA_LIDAR
    rplidar_node      Slamtec driver: reads the LiDAR, PUBLISHES the /scan TOPIC (LaserScan)
    lidar_tf          static TF  base_link -> laser   (where the LiDAR sits on Nova)
    robot_state_publisher   reads urdf/nova.urdf, publishes /robot_description + Nova's TF
    scan_to_server    SUBSCRIBES to /scan, sends it to the Nova server (Safe drive / Auto forward)
    rviz2             the view: Nova's outline + red LiDAR dots, front = white strip

  Options (name:=value):
    rviz:=false               no RViz window
    scan_to_server:=false     don't feed the Nova server
    foxglove:=true            also start the Foxglove bridge (ws://<laptop-ip>:8765)
    server:=http://IP:8090    Nova server address (default auto: localhost, then the Windows host)
    lidar_x:=0.15 lidar_z:=0.25 lidar_yaw:=3.14159   where the LiDAR is (metres / radians)

Before starting: on the Nova page, Safe drive -> LiDAR link -> "ROS" (only one LiDAR reader at a time).
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, TimerAction
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

# ---- where the LiDAR sits on Nova (metres from the centre between the wheels, at floor level)
LIDAR_X = '0.15'       # forward (+) / back (-)        MEASURE and change
LIDAR_Y = '0.0'        # left (+) / right (-)
LIDAR_Z = '0.25'       # height above the floor        MEASURE and change
LIDAR_YAW = '3.14159'  # arrow facing Nova's front: the driver's 0 deg is opposite the arrow (same as Scout)
# ----------------------------------------------------------------------------------------------

PORT = '/tmp/ttyNOVA_LIDAR'   # created by nova_lidar_link.sh


def generate_launch_description():
    share = get_package_share_directory('nova_bringup')
    with open(os.path.join(share, 'urdf', 'nova.urdf')) as f:
        urdf = f.read()
    arg = LaunchConfiguration

    rplidar = Node(
        package='rplidar_ros', executable='rplidar_node', name='rplidar_node', output='screen',
        respawn=True, respawn_delay=3.0,            # if Wi-Fi drops, the driver restarts by itself
        parameters=[{'serial_port': PORT, 'serial_baudrate': 460800, 'frame_id': 'laser',
                     'scan_mode': 'Standard', 'angle_compensate': True, 'inverted': False}])

    return LaunchDescription([
        DeclareLaunchArgument('server', default_value='auto'),
        DeclareLaunchArgument('rviz', default_value='true'),
        DeclareLaunchArgument('scan_to_server', default_value='true'),
        DeclareLaunchArgument('foxglove', default_value='false'),
        DeclareLaunchArgument('lidar_x', default_value=LIDAR_X),
        DeclareLaunchArgument('lidar_y', default_value=LIDAR_Y),
        DeclareLaunchArgument('lidar_z', default_value=LIDAR_Z),
        DeclareLaunchArgument('lidar_yaw', default_value=LIDAR_YAW),

        # 1. Wi-Fi link to the LiDAR, then the driver 3 s later (the virtual port must exist first)
        Node(package='nova_bringup', executable='nova_lidar_link.sh', name='nova_lidar_link',
             output='screen', arguments=[arg('server')]),
        TimerAction(period=3.0, actions=[rplidar]),

        # 2. where things are: LiDAR on Nova (static TF) + Nova's outline (URDF)
        Node(package='tf2_ros', executable='static_transform_publisher', name='lidar_tf',
             arguments=['--x', arg('lidar_x'), '--y', arg('lidar_y'), '--z', arg('lidar_z'),
                        '--yaw', arg('lidar_yaw'), '--frame-id', 'base_link', '--child-frame-id', 'laser']),
        Node(package='robot_state_publisher', executable='robot_state_publisher',
             name='robot_state_publisher', parameters=[{'robot_description': urdf}]),

        # 3. feed the Nova server (Safe drive + Auto forward keep working, now fed by ROS)
        Node(package='nova_bringup', executable='scan_to_server.py', name='scan_to_server', output='screen',
             parameters=[{'server': arg('server'), 'yaw_offset_rad': arg('lidar_yaw')}],
             condition=IfCondition(arg('scan_to_server'))),

        # 4. viewers
        Node(package='rviz2', executable='rviz2', name='rviz2',
             arguments=['-d', os.path.join(share, 'rviz', 'nova.rviz')],
             condition=IfCondition(arg('rviz'))),
        Node(package='foxglove_bridge', executable='foxglove_bridge', name='foxglove_bridge',
             parameters=[{'port': 8765}], condition=IfCondition(arg('foxglove'))),
    ])
