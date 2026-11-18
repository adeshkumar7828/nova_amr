# Nova AMR – ROS 2 (Humble, WSL Ubuntu 22.04)

```
ros/
├── setup_wsl.sh              one command: installs tools, builds ~/nova_ws, sets up the terminal
└── nova_bringup/             Nova's ROS 2 package
    ├── launch/lidar.launch.py   LiDAR over Wi-Fi + Nova outline + RViz + scans to the Nova page
    ├── scripts/nova_lidar_link.sh  Wi-Fi link to the LiDAR bridge on Nova's ESP32 (/tmp/ttyNOVA_LIDAR)
    ├── scripts/scan_to_server.py   /scan -> Nova server (Safe drive + Auto forward keep working)
    ├── urdf/nova.urdf           Nova's outline (EDIT the sizes)
    └── rviz/nova.rviz           ready-made RViz view
```

## First time (in the Ubuntu terminal)
```
bash "/mnt/d/Mobilise/Nova AMR/ros/setup_wsl.sh"
source ~/.bashrc
```
Run the same command again after changing any file in this `ros` folder (it copies + rebuilds).

## Every time
1. Windows: Nova server running (`cd "D:\Mobilise\Nova AMR\app"` → `npm start`), Nova powered on.
2. Nova page → Safe drive → LiDAR link → **ROS**.
3. Ubuntu: `ros2 launch nova_bringup lidar.launch.py`
4. RViz opens: blue box = Nova, white strip = its front, red dots = LiDAR.
5. Stop: Ctrl+C (the ESP32 stops the LiDAR). Back to the old way: page → **Laptop (direct)**.

## Useful ROS commands (second Ubuntu terminal)
| Command | Shows |
|---|---|
| `ros2 node list` | running nodes |
| `ros2 topic list` | topics (/scan, /tf, /tf_static, /robot_description …) |
| `ros2 topic hz /scan` | scans per second (~10) |
| `ros2 topic echo /scan --once` | one LaserScan message |
| `ros2 run tf2_tools view_frames` | PDF of the TF tree (base_link → laser …) |

## Adjust to Nova
- LiDAR position: top of `launch/lidar.launch.py` (LIDAR_X, LIDAR_Z, LIDAR_YAW) or `lidar_x:=0.12` on the command line.
- Nova's size: `urdf/nova.urdf` (body box, wheel positions). Then rerun `setup_wsl.sh`.
