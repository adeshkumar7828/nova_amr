#!/usr/bin/env bash
# =============================================================================================
#  Nova AMR - ROS 2 Humble setup in WSL (Ubuntu 22.04). One command, safe to run again:
#
#     bash "/mnt/d/Mobilise/Nova AMR/ros/setup_wsl.sh"
#
#  Run it again any time the files in D:\Mobilise\Nova AMR\ros change: it copies the latest
#  nova_bringup into the workspace and rebuilds.
# =============================================================================================
set -e
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"        # .../Nova AMR/ros  (on the D: drive)
WS="$HOME/nova_ws"
step() { echo; echo "== $*"; }

step "1. Checking Ubuntu + ROS 2"
. /etc/os-release
echo "   Ubuntu $VERSION_ID"
[ "$VERSION_ID" = "22.04" ] || echo "   WARNING: this script is made for Ubuntu 22.04 (Humble)."
if [ ! -f /opt/ros/humble/setup.bash ]; then
  echo "   ERROR: ROS 2 Humble not found in /opt/ros/humble. Install 'ros-humble-desktop' first."; exit 1
fi
source /opt/ros/humble/setup.bash
echo "   ROS_DISTRO = $ROS_DISTRO"

step "2. Installing tools (asks for your Ubuntu password once)"
sudo apt update
sudo apt install -y git socat curl iproute2 python3-colcon-common-extensions \
  ros-humble-rviz2 ros-humble-robot-state-publisher ros-humble-tf2-ros ros-humble-foxglove-bridge

step "3. Workspace + Slamtec LiDAR driver"
mkdir -p "$WS/src"
if [ -d "$WS/src/rplidar_ros/.git" ]; then
  echo "   rplidar_ros already there"
else
  git clone -b ros2 https://github.com/Slamtec/rplidar_ros.git "$WS/src/rplidar_ros"
fi

step "4. Copying nova_bringup from the D: drive (Windows line endings removed)"
rm -rf "$WS/src/nova_bringup"
cp -r "$SRC_DIR/nova_bringup" "$WS/src/nova_bringup"
find "$WS/src/nova_bringup" -type f \( -name '*.py' -o -name '*.sh' -o -name '*.xml' -o -name '*.txt' \
  -o -name '*.urdf' -o -name '*.rviz' \) -exec sed -i 's/\r$//' {} +
chmod +x "$WS/src/nova_bringup/scripts/"*

step "5. Building (first time: a few minutes)"
cd "$WS"
colcon build --symlink-install
echo "   build OK"

step "6. Terminal settings (~/.bashrc)"
add() { grep -qxF "$1" "$HOME/.bashrc" || { echo "$1" >> "$HOME/.bashrc"; echo "   added: $1"; }; }
add "source /opt/ros/humble/setup.bash"
add "source $WS/install/setup.bash"
add "export ROS_DOMAIN_ID=7    # Nova's own ROS channel (never mixes with Scout's Jetson)"

step "7. Can WSL reach the Nova server and Nova?"
GW=$(ip route | awk '/^default/ {print $3; exit}')
SERVER=""
for u in http://localhost:8090 ${GW:+http://$GW:8090}; do
  if curl -s --max-time 2 "$u/api/status" >/dev/null 2>&1; then SERVER="$u"; break; fi
done
if [ -z "$SERVER" ]; then
  echo "   Nova server NOT reachable from WSL (tried localhost and $GW)."
  echo "   -> Start it on Windows (cd \"D:\\Mobilise\\Nova AMR\\app\" ; npm start) and run this script again."
else
  echo "   Nova server: $SERVER  OK"
  NOVA_IP=$(curl -s "$SERVER/api/status" | python3 -c 'import sys,json; print((json.load(sys.stdin).get("robot") or {}).get("ip") or "")' 2>/dev/null || true)
  if [ -n "$NOVA_IP" ]; then
    if timeout 3 bash -c "</dev/tcp/$NOVA_IP/8899" 2>/dev/null; then
      echo "   Nova's LiDAR bridge $NOVA_IP:8899  OK (reachable from WSL)"
    else
      echo "   Nova at $NOVA_IP, but its LiDAR port 8899 is not reachable from WSL right now"
      echo "   (fine if the page is still on 'Laptop (direct)' and holding the link)."
    fi
  else
    echo "   Nova is not connected to the server right now (power it on to test)."
  fi
fi

echo
echo "================================================================================"
echo " DONE. Open a NEW Ubuntu terminal (or run:  source ~/.bashrc ), then:"
echo "   1. Nova page -> Safe drive -> LiDAR link -> click \"ROS\""
echo "   2. ros2 launch nova_bringup lidar.launch.py"
echo " RViz opens: Nova's outline (white strip = front) + red LiDAR dots."
echo "================================================================================"
