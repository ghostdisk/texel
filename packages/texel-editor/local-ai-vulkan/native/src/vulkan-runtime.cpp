#include <texel-vulkan-runtime.h>
#include <mutex>
#include <stdexcept>

static std::mutex instance_mutex;
static VkInstance shared_instance = VK_NULL_HANDLE;
static VkResult loader_result = VK_ERROR_INITIALIZATION_FAILED;
static std::once_flag loader_once;

extern "C" VkResult texel_vk_initialize_loader() {
    std::call_once(loader_once, [] { loader_result = volkInitialize(); });
    return loader_result;
}

extern "C" VkInstance texel_vk_acquire_instance(const VkInstanceCreateInfo* create_info) {
    std::lock_guard<std::mutex> lock(instance_mutex);
    if (shared_instance) return shared_instance;
    if (texel_vk_initialize_loader() != VK_SUCCESS) throw std::runtime_error("No system Vulkan loader is available.");
    const VkResult result = vkCreateInstance(create_info, nullptr, &shared_instance);
    if (result != VK_SUCCESS) throw std::runtime_error("Could not create the shared Vulkan instance.");
    volkLoadInstance(shared_instance);
    return shared_instance;
}

extern "C" void texel_vk_release_instance() {
    std::lock_guard<std::mutex> lock(instance_mutex);
    if (!shared_instance) return;
    vkDestroyInstance(shared_instance, nullptr);
    shared_instance = VK_NULL_HANDLE;
}
