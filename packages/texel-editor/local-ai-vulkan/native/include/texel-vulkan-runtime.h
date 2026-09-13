#pragma once

#include <volk.h>

extern "C" VkResult texel_vk_initialize_loader();
extern "C" VkInstance texel_vk_acquire_instance(const VkInstanceCreateInfo* create_info);
extern "C" void texel_vk_release_instance();
