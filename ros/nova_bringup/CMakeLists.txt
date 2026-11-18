cmake_minimum_required(VERSION 3.8)
project(nova_bringup)

find_package(ament_cmake REQUIRED)

# launch files, robot outline (URDF) and the RViz view
install(DIRECTORY launch urdf rviz DESTINATION share/${PROJECT_NAME})

# small helper programs, runnable as nodes:  ros2 run nova_bringup <name>
install(PROGRAMS
  scripts/nova_lidar_link.sh
  scripts/scan_to_server.py
  DESTINATION lib/${PROJECT_NAME})

ament_package()
