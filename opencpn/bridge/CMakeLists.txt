cmake_minimum_required(VERSION 3.20)
project(ocpn_bridge_pi LANGUAGES CXX)

# Target: OpenCPN 5.14 Windows (Win32/x86, wxWidgets 3.2 vc14x DLLs).
# Build:  cmake -B build -G "Visual Studio 17 2022" -A Win32
#         cmake --build build --config Release

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(WXDIR ${CMAKE_SOURCE_DIR}/cache/wxWidgets)
set(OCPN_API ${CMAKE_SOURCE_DIR}/../ocpn-bridge-libs/api-18)

add_library(ocpn_bridge_pi SHARED src/bridge_pi.cpp src/http_bridge.cpp)

target_compile_definitions(ocpn_bridge_pi PRIVATE
  __WXMSW__ _UNICODE UNICODE WXUSINGDLL
  _CRT_SECURE_NO_WARNINGS
  # OpenCPN ships an older msvcp140.dll; VS2022's constexpr std::mutex
  # crashes against it. This define restores the compatible layout.
  _DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR
)

# include/msvc must come first: its wx/setup.h does the MSVC auto-link.
target_include_directories(ocpn_bridge_pi PRIVATE
  ${WXDIR}/include/msvc
  ${WXDIR}/include
  ${OCPN_API}
  ${CMAKE_SOURCE_DIR}/third_party
)

target_link_directories(ocpn_bridge_pi PRIVATE ${WXDIR}/lib/vc_dll)

target_link_libraries(ocpn_bridge_pi PRIVATE
  ${OCPN_API}/msvc-wx32/opencpn.lib
  ws2_32
)

set_target_properties(ocpn_bridge_pi PROPERTIES PREFIX "")
