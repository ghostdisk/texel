import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const dependencies = [
  {
    folder: 'stable-diffusion.cpp',
    url: 'https://github.com/leejet/stable-diffusion.cpp',
    revision: '7f410a3793c5bba8eb198e962ce7a3d6095f9d89',
    recursive: true,
  },
  {
    folder: 'vision.cpp',
    url: 'https://github.com/Acly/vision.cpp',
    revision: '26a752912d49f6c4ff4545b35a1bdf7400d349ed',
    recursive: true,
  },
  {
    folder: 'volk',
    url: 'https://github.com/zeux/volk',
    revision: 'e640c6ea6420bdaf6248e85f736ab0b99491ae58',
    recursive: false,
  },
];

function run(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error('git exited with ' + result.status);
}

for (const dependency of dependencies) {
  const directory = path.join(root, 'third_party', dependency.folder);
  if (!existsSync(path.join(directory, 'CMakeLists.txt'))) {
    run(['clone', dependency.url, directory]);
    run(['checkout', dependency.revision], directory);
    if (dependency.recursive) run(['submodule', 'update', '--init', '--recursive'], directory);
  }
}

const vanillaLink = 'target_link_libraries(ggml-vulkan PRIVATE Vulkan::Vulkan)';
const previousLink = `if(TEXEL_USE_VOLK)
        target_link_libraries(ggml-vulkan PRIVATE volk)
        target_compile_definitions(ggml-vulkan PRIVATE VK_NO_PROTOTYPES NOMINMAX)
        if(MSVC)
            target_compile_options(ggml-vulkan PRIVATE /FIvolk.h)
        else()
            target_compile_options(ggml-vulkan PRIVATE -include volk.h)
        endif()
    else()
        ${vanillaLink}
    endif()`;
const sharedLink = `if(TEXEL_SHARED_VULKAN_RUNTIME)
        target_compile_definitions(ggml-vulkan PRIVATE VK_NO_PROTOTYPES NOMINMAX)
        target_include_directories(ggml-vulkan PRIVATE
            \${TEXEL_VULKAN_RUNTIME_INCLUDE}
            \${TEXEL_VOLK_SOURCE_DIR}
            \${Vulkan_INCLUDE_DIRS}
        )
        if(MSVC)
            target_compile_options(ggml-vulkan PRIVATE /FItexel-vulkan-runtime.h)
        else()
            target_compile_options(ggml-vulkan PRIVATE -include texel-vulkan-runtime.h)
        endif()
    else()
        ${vanillaLink}
    endif()`;
const sharedLinkWithoutSdkHeaders = sharedLink.replace('            \${Vulkan_INCLUDE_DIRS}\n', '');

for (const relative of [
  'stable-diffusion.cpp/ggml/src/ggml-vulkan/CMakeLists.txt',
  'vision.cpp/depend/llama/ggml/src/ggml-vulkan/CMakeLists.txt',
]) {
  const file = path.join(root, 'third_party', relative);
  let source = readFileSync(file, 'utf8');
  if (!source.includes(sharedLink)) {
    if (source.includes(sharedLinkWithoutSdkHeaders)) source = source.replace(sharedLinkWithoutSdkHeaders, sharedLink);
    else if (source.includes(previousLink)) source = source.replace(previousLink, sharedLink);
    else if (source.includes(vanillaLink)) source = source.replace(vanillaLink, sharedLink);
    else throw new Error('Unable to patch shared Vulkan linkage in ' + file);
    writeFileSync(file, source);
  }
}

function patchShaderGenerator(relative, namespace) {
  const file = path.join(root, 'third_party', relative);
  const originalSource = readFileSync(file, 'utf8');
  let source = originalSource;
  const include = 'src << "#include \\"" << basename(target_hpp) << "\\"\\n\\n";';
  const sharedInclude = 'src << "#include \\"" << basename(target_hpp) << "\\"\\n#include \\"texel-shader-runtime.h\\"\\n\\n";';
  if (source.includes(include)) source = source.replace(include, sharedInclude);
  source = source.replace(
    'hdr << "extern const unsigned char " << name << "_data[];\\n\\n";',
    'hdr << "extern const unsigned char* " << name << "_data;\\n\\n";',
  );
  const embedded = `src << "const unsigned char " << name << "_data[" << data.size() << "] = {\\n" << std::hex;
            auto bytes = reinterpret_cast<const uint8_t*>(data.data());
            for (size_t i = 0; i < data.size(); ++i) {
                src << "0x" << static_cast<int>(bytes[i]) << ",";
                if ((i + 1) % 12 == 0) src << "\\n";
            }
            src << std::dec << "\\n};\\n\\n";`;
  const external = `src << "const unsigned char* " << name << "_data = texel_shader_data(\\"${namespace}/" << name << "\\", " << data.size() << ");\\n\\n";`;
  if (source.includes(embedded)) source = source.replace(embedded, external);
  if (!source.includes(sharedInclude) || !source.includes(external)) {
    throw new Error('Unable to patch external shader storage in ' + file);
  }
  if (source !== originalSource) writeFileSync(file, source);
}

patchShaderGenerator(
  'stable-diffusion.cpp/ggml/src/ggml-vulkan/vulkan-shaders/vulkan-shaders-gen.cpp',
  'stable',
);
patchShaderGenerator(
  'vision.cpp/depend/llama/ggml/src/ggml-vulkan/vulkan-shaders/vulkan-shaders-gen.cpp',
  'vision',
);

const sharedCreate = 'vk_instance.instance = vk::Instance(texel_vk_acquire_instance(reinterpret_cast<const VkInstanceCreateInfo*>(&instance_create_info)));';
for (const relative of [
  'stable-diffusion.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp',
  'vision.cpp/depend/llama/ggml/src/ggml-vulkan/ggml-vulkan.cpp',
]) {
  const file = path.join(root, 'third_party', relative);
  let source = readFileSync(file, 'utf8');
  if (source.includes(sharedCreate)) continue;
  const original = 'vk_instance.instance = vk::createInstance(instance_create_info);';
  if (!source.includes(original)) throw new Error('Unable to patch shared Vulkan instance in ' + file);
  source = source.replace(original, sharedCreate);
  writeFileSync(file, source);
}

const sharedLoader = `if (texel_vk_initialize_loader() != VK_SUCCESS) {
        throw std::runtime_error("No system Vulkan loader is available.");
    }

    ggml_vk_default_dispatcher_instance.init(vkGetInstanceProcAddr);`;
for (const relative of [
  'stable-diffusion.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp',
  'vision.cpp/depend/llama/ggml/src/ggml-vulkan/ggml-vulkan.cpp',
]) {
  const file = path.join(root, 'third_party', relative);
  let source = readFileSync(file, 'utf8');
  if (source.includes(sharedLoader)) continue;
  const original = 'ggml_vk_default_dispatcher_instance.init(vkGetInstanceProcAddr);';
  if (!source.includes(original)) throw new Error('Unable to patch shared Vulkan loader initialization in ' + file);
  source = source.replace(original, sharedLoader);
  writeFileSync(file, source);
}
