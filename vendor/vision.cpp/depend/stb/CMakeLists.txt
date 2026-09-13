if(NOT TEXEL_STB_SOURCE)
  message(FATAL_ERROR "TEXEL_STB_SOURCE must point to the vendored STB source")
endif()

add_library(stb STATIC stb.cpp)
target_include_directories(stb PUBLIC "${TEXEL_STB_SOURCE}")
target_compile_options(stb PRIVATE ${VISP_NO_WARNINGS})
set_target_properties(stb PROPERTIES POSITION_INDEPENDENT_CODE ON)
