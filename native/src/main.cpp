#include <ixwebsocket/IXWebSocketServer.h>
#include <ixwebsocket/IXGetFreePort.h>
#include <stable-diffusion.h>
#include <migan.h>
#include <json.hpp>
#define STB_IMAGE_WRITE_STATIC
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>
#include <algorithm>
#include <cmath>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <thread>
#include <vector>

using Json = nlohmann::json;
namespace fs = std::filesystem;

struct Session {
    std::weak_ptr<ix::WebSocket> socket;
    std::atomic<bool> authenticated{false};
};

struct Job {
    std::string id;
    std::shared_ptr<Session> session;
    Json request;
    std::vector<uint8_t> input;
    std::vector<uint8_t> mask;
    std::atomic<bool> cancelled{false};
    std::atomic<bool> sampling{false};
    int sample_steps = 0;
    std::chrono::steady_clock::time_point last_preview{};
};

static void send_json(const std::shared_ptr<Session>& session, const Json& value) {
    if (auto socket = session->socket.lock()) socket->send(value.dump());
}

static std::string encode_image(const Job& job, const char* type, const sd_image_t& image, int step = 0) {
    const int requested_width = job.request.at("width").get<int>();
    const int requested_height = job.request.at("height").get<int>();
    const bool removal = job.request.at("type") == "remove";
    const int padded_width = removal ? requested_width : std::max(64, (requested_width + 15) / 16 * 16);
    const int padded_height = removal ? requested_height : std::max(64, (requested_height + 15) / 16 * 16);
    const int width = std::max(1, static_cast<int>((static_cast<uint64_t>(image.width) * requested_width + padded_width - 1) / padded_width));
    const int height = std::max(1, static_cast<int>((static_cast<uint64_t>(image.height) * requested_height + padded_height - 1) / padded_height));
    std::string png;
    const auto write = [](void* context, void* data, int size) {
        static_cast<std::string*>(context)->append(static_cast<const char*>(data), size);
    };
    if (!stbi_write_png_to_func(write, &png, width, height, image.channel, image.data, image.width * image.channel)) {
        throw std::runtime_error("Could not encode generated image.");
    }
    const auto header = Json{{"type", type}, {"id", job.id}, {"width", width}, {"height", height}, {"step", step}}.dump();
    const uint32_t length = static_cast<uint32_t>(header.size());
    std::string packet;
    for (int shift = 0; shift < 32; shift += 8) packet.push_back(static_cast<char>((length >> shift) & 255));
    packet += header;
    packet += png;
    return packet;
}

static void send_preview(Job& job, const sd_image_t& image, int step) {
    if (job.cancelled) return;
    auto socket = job.session->socket.lock();
    if (!socket || socket->bufferedAmount() > 4 * 1024 * 1024) return;
    socket->sendBinary(encode_image(job, "preview", image, step));
}

class Backend {
    Json models_;
    fs::path model_root_;
    std::string token_;
    std::string backend_;
    std::string budget_;
    std::mutex job_mutex_;
    std::mutex context_mutex_;
    std::shared_ptr<Job> job_;
    std::thread worker_;
    std::atomic<bool> busy_{false};
    sd_ctx_t* context_ = nullptr;
    std::string loaded_model_;
    std::unique_ptr<TexelMigan, decltype(&texel_migan_destroy)> migan_{nullptr, texel_migan_destroy};
    std::string loaded_migan_;

    static void progress(int step, int steps, float seconds, void* data) {
        auto& job = *static_cast<Job*>(data);
        if (job.cancelled || !job.sampling || steps != job.sample_steps) return;
        try { send_json(job.session, {{"type", "progress"}, {"id", job.id}, {"step", step}, {"steps", steps}, {"seconds", seconds}, {"phase", step == steps ? "Decoding image" : "Sampling"}}); }
        catch (...) {}
        if (step == steps) job.sampling = false;
    }

    static void preview(int step, int count, sd_image_t* frames, bool, void* data) {
        auto& job = *static_cast<Job*>(data);
        if (job.cancelled) return;
        job.sampling = true;
        progress(step, job.sample_steps, 0, data);
        const auto now = std::chrono::steady_clock::now();
        if (job.cancelled || count < 1 || !frames || now - job.last_preview < std::chrono::milliseconds(200)) return;
        job.last_preview = now;
        try { send_preview(job, frames[0], step); }
        catch (const std::exception& error) { std::cerr << "Preview: " << error.what() << '\n'; }
    }

    fs::path model_path(const Json& model, const char* key) const {
        const auto path = model_root_ / model.at(key).get<std::string>();
        if (!fs::is_regular_file(path)) throw std::runtime_error("Missing model file: " + path.string());
        return path;
    }

    void load_model(const Json& model, Job& job) {
        if (loaded_model_ == model.at("id").get<std::string>() && context_) return;
        migan_.reset();
        loaded_migan_.clear();
        send_json(job.session, {{"type", "progress"}, {"id", job.id}, {"phase", "Loading model"}, {"step", 0}, {"steps", 0}});
        const auto diffusion = model_path(model, "diffusion").string();
        const auto llm = model_path(model, "llm").string();
        const auto vae = model_path(model, "vae").string();
        {
            std::lock_guard<std::mutex> lock(context_mutex_);
            if (context_) free_sd_ctx(context_);
            context_ = nullptr;
            loaded_model_.clear();
        }
        sd_ctx_params_t params;
        sd_ctx_params_init(&params);
        params.diffusion_model_path = diffusion.c_str();
        params.llm_path = llm.c_str();
        params.vae_path = vae.c_str();
        params.n_threads = std::max(1, sd_get_num_physical_cores() / 2);
        params.enable_mmap = true;
        params.flash_attn = true;
        params.diffusion_flash_attn = true;
        params.auto_fit = true;
        params.params_backend = "CPU";
        params.backend = backend_.empty() ? nullptr : backend_.c_str();
        params.max_vram = budget_.empty() ? nullptr : budget_.c_str();
        auto* context = new_sd_ctx(&params);
        if (!context) throw std::runtime_error("Could not load the model. See the native backend log.");
        {
            std::lock_guard<std::mutex> lock(context_mutex_);
            context_ = context;
            loaded_model_ = model.at("id").get<std::string>();
        }
    }

    std::string remove(const Json& model, Job& job) {
        char error[512]{};
        const auto id = model.at("id").get<std::string>();
        if (!migan_ || loaded_migan_ != id) {
            const auto weights = model_path(model, "weights").string();
            send_json(job.session, {{"type", "progress"}, {"id", job.id}, {"phase", "Loading MI-GAN"}, {"step", 0}, {"steps", 0}});
            {
                std::lock_guard<std::mutex> lock(context_mutex_);
                if (context_) free_sd_ctx(context_);
                context_ = nullptr;
                loaded_model_.clear();
            }
            migan_.reset();
            loaded_migan_.clear();
            migan_.reset(texel_migan_load(weights.c_str(), backend_ == "CPU", error, sizeof(error)));
            if (!migan_) throw std::runtime_error(std::string("Could not load MI-GAN: ") + error);
            loaded_migan_ = id;
        }
        if (job.cancelled) return {};
        send_json(job.session, {{"type", "progress"}, {"id", job.id}, {"phase", "Removing selection"}, {"step", 0}, {"steps", 1}});
        const int width = job.request.at("width").get<int>(), height = job.request.at("height").get<int>();
        std::vector<uint8_t> output(static_cast<size_t>(width) * height * 3);
        if (!texel_migan_remove(migan_.get(), width, height, job.input.data(), job.mask.data(), output.data(), error, sizeof(error))) {
            throw std::runtime_error(std::string("MI-GAN removal failed: ") + error);
        }
        if (job.cancelled) return {};
        return encode_image(job, "result", {static_cast<uint32_t>(width), static_cast<uint32_t>(height), 3, output.data()});
    }

    void generate(const std::shared_ptr<Job>& job) {
        sd_image_t* images = nullptr;
        int image_count = 0;
        std::string result;
        Json terminal;
        try {
            const auto model_id = job->request.at("model").get<std::string>();
            const auto found = std::find_if(models_.begin(), models_.end(), [&](const auto& model) { return model.at("id") == model_id; });
            if (found == models_.end()) throw std::runtime_error("Unknown local model.");
            const bool removal = job->request.at("type") == "remove";
            if (found->value("task", std::string{"generate"}) != (removal ? "remove" : "generate")) {
                throw std::runtime_error("The model does not support this operation.");
            }
            if (removal) result = remove(*found, *job);
            else {
                load_model(*found, *job);
                if (!job->cancelled) {
                    const auto prompt = job->request.at("prompt").get<std::string>();
                    const auto negative = job->request.value("negativePrompt", std::string{});
                    sd_img_gen_params_t params;
                    sd_img_gen_params_init(&params);
                    params.prompt = prompt.c_str();
                    params.negative_prompt = negative.c_str();
                    params.width = std::max(64, (job->request.at("width").get<int>() + 15) / 16 * 16);
                    params.height = std::max(64, (job->request.at("height").get<int>() + 15) / 16 * 16);
                    params.seed = job->request.value("seed", int64_t{-1});
                    if (params.seed < 0) params.seed = static_cast<int64_t>(std::random_device{}()) & 0x7fffffff;
                    params.batch_count = 1;
                    params.strength = job->request.value("strength", 0.75f);
                    params.sample_params.sample_steps = job->request.value("steps", 20);
                    params.sample_params.sample_method = EULER_SAMPLE_METHOD;
                    params.sample_params.scheduler = sd_get_default_scheduler(context_, EULER_SAMPLE_METHOD);
                    params.sample_params.guidance.txt_cfg = job->request.value("guidance", 6.0f);
                    params.vae_tiling_params.enabled = true;
                    if (!job->input.empty()) {
                        params.init_image = {static_cast<uint32_t>(params.width), static_cast<uint32_t>(params.height), 3, job->input.data()};
                    }
                    if (!job->mask.empty()) params.mask_image = {static_cast<uint32_t>(params.width), static_cast<uint32_t>(params.height), 1, job->mask.data()};
                    sd_set_progress_callback(progress, job.get());
                    sd_set_preview_callback(preview, PREVIEW_PROJ, 1, true, false, job.get());
                    {
                        std::lock_guard<std::mutex> lock(context_mutex_);
                        sd_cancel_generation(context_, job->cancelled ? SD_CANCEL_ALL : SD_CANCEL_RESET);
                    }
                    send_json(job->session, {{"type", "progress"}, {"id", job->id}, {"phase", job->input.empty() ? "Starting generation" : "Encoding input"}, {"step", 0}, {"steps", 0}, {"seed", params.seed}});
                    const bool success = generate_image(context_, &params, &images, &image_count);
                    if (!job->cancelled) {
                        if (!success || image_count < 1 || !images) throw std::runtime_error("Image generation failed. See the native backend log.");
                    result = encode_image(*job, "result", images[0]);
                    }
                }
            }
        } catch (const std::exception& error) {
            terminal = {{"type", "error"}, {"id", job->id}, {"message", error.what()}};
        }
        sd_set_progress_callback(nullptr, nullptr);
        sd_set_preview_callback(nullptr, PREVIEW_NONE, 1, false, false, nullptr);
        if (images) free_sd_images(images, image_count);
        {
            std::lock_guard<std::mutex> lock(job_mutex_);
            if (job->cancelled) terminal = {{"type", "cancelled"}, {"id", job->id}};
            job_.reset();
            busy_ = false;
        }
        // A terminal message makes the client eligible to start its next request.
        // Retire this job and its callbacks before publishing that boundary.
        try {
            if (!terminal.is_null()) send_json(job->session, terminal);
            else if (auto socket = job->session->socket.lock()) socket->sendBinary(result);
        } catch (const std::exception& error) { std::cerr << "Job completion: " << error.what() << '\n'; }
    }

public:
    Backend(fs::path root, fs::path config, std::string token) : model_root_(std::move(root)), token_(std::move(token)) {
        std::ifstream stream(config);
        if (!stream) throw std::runtime_error("Could not open model configuration: " + config.string());
        models_ = Json::parse(stream).at("models");
        if (const char* value = std::getenv("IMGED_INFERENCE_BACKEND")) backend_ = value;
        if (const char* value = std::getenv("IMGED_MAX_VRAM")) budget_ = value;
    }

    ~Backend() {
        cancel(nullptr, "");
        if (worker_.joinable()) worker_.join();
        if (context_) free_sd_ctx(context_);
    }

    void cancel(const std::shared_ptr<Session>& session, const std::string& id) {
        std::lock_guard<std::mutex> lock(job_mutex_);
        if (!job_ || !busy_ || (session && job_->session != session) || (!id.empty() && job_->id != id)) return;
        job_->cancelled = true;
        std::lock_guard<std::mutex> context_lock(context_mutex_);
        if (context_) sd_cancel_generation(context_, SD_CANCEL_ALL);
    }

    void message(const std::shared_ptr<Session>& session, const std::string& data, bool binary) {
        std::string id;
        try {
            if (data.size() > 40 * 1024 * 1024) throw std::runtime_error("Generation request is too large.");
            Json request;
            size_t offset = 0;
            if (binary) {
                if (data.size() < 4) throw std::runtime_error("Missing binary header.");
                uint32_t length = 0;
                for (int i = 0; i < 4; ++i) length |= static_cast<uint32_t>(static_cast<uint8_t>(data[i])) << (i * 8);
                if (length > 65536 || static_cast<size_t>(length) + 4 > data.size()) throw std::runtime_error("Invalid binary header.");
                request = Json::parse(data.begin() + 4, data.begin() + 4 + length);
                offset = 4 + length;
            } else {
                if (data.size() > 65536) throw std::runtime_error("Control message is too large.");
                request = Json::parse(data);
            }
            id = request.value("id", std::string{});
            const auto type = request.at("type").get<std::string>();
            if (!session->authenticated) {
                if (binary || type != "hello" || request.value("token", std::string{}) != token_) {
                    if (auto socket = session->socket.lock()) socket->close(1008, "Authentication required");
                    return;
                }
                session->authenticated = true;
                Json available = Json::array();
                for (const auto& model : models_) {
                    try {
                        const auto task = model.value("task", std::string{"generate"});
                        if (task == "remove") model_path(model, "weights");
                        else { model_path(model, "diffusion"); model_path(model, "llm"); model_path(model, "vae"); }
                        available.push_back({{"id", model.at("id")}, {"label", model.value("label", model.at("id"))}, {"source", "local"}, {"task", task}});
                    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
                }
                send_json(session, {{"type", "models"}, {"models", available}, {"protocol", 1}});
                return;
            }
            if (type == "cancel") { cancel(session, id); return; }
            if ((type != "generate" && type != "remove") || !binary || id.empty() || id.size() > 128) throw std::runtime_error("Invalid image request.");
            const bool removal = type == "remove";
            const int width = request.at("width").get<int>();
            const int height = request.at("height").get<int>();
            if (width < 1 || height < 1 || width > 2048 || height > 2048) {
                throw std::runtime_error("Local generation supports layers up to 2048 pixels on each side.");
            }
            const size_t pixels = static_cast<size_t>(width) * height;
            const size_t input_bytes = request.at("inputBytes").get<size_t>();
            const size_t mask_bytes = request.value("maskBytes", size_t{0});
            if ((input_bytes != 0 && input_bytes != pixels * 4) || (mask_bytes != 0 && mask_bytes != pixels * 4) ||
                data.size() - offset != input_bytes + mask_bytes) {
                throw std::runtime_error("Image data does not match the layer dimensions.");
            }
            if (mask_bytes && !input_bytes) throw std::runtime_error("A mask requires an image input.");
            if (removal && !mask_bytes) throw std::runtime_error("Removal requires a selection.");
            const int steps = request.value("steps", 20);
            const float strength = request.value("strength", 0.75f);
            const float guidance = request.value("guidance", 6.0f);
            if (steps < 1 || steps > 100 || !std::isfinite(strength) || strength < 0.01f || strength > 1 ||
                !std::isfinite(guidance) || guidance < 0 || guidance > 30 || request.at("prompt").get<std::string>().size() > 16384) {
                throw std::runtime_error("Invalid generation settings.");
            }
            auto job = std::make_shared<Job>();
            job->sample_steps = strength < 1 ? static_cast<int>(steps * strength) + 1 : steps;
            job->id = id;
            job->session = session;
            job->request = std::move(request);
            const int padded_width = removal ? width : std::max(64, (width + 15) / 16 * 16);
            const int padded_height = removal ? height : std::max(64, (height + 15) / 16 * 16);
            const size_t padded_pixels = static_cast<size_t>(padded_width) * padded_height;
            if (input_bytes) job->input.resize(padded_pixels * 3);
            if (mask_bytes) job->mask.resize(padded_pixels, 0);
            if (input_bytes) for (int y = 0; y < padded_height; ++y) for (int x = 0; x < padded_width; ++x) {
                const size_t destination = static_cast<size_t>(y) * padded_width + x;
                const size_t source = static_cast<size_t>(std::min(y, height - 1)) * width + std::min(x, width - 1);
                for (size_t channel = 0; channel < 3; ++channel) job->input[destination * 3 + channel] = static_cast<uint8_t>(data[offset + source * 4 + channel]);
                // The sampler rounds its mask to binary. Keep every selected pixel in
                // its support; the editor applies the original soft coverage exactly once.
                if (mask_bytes && x < width && y < height) job->mask[destination] = data[offset + input_bytes + source * 4] != 0 ? 255 : 0;
            }
            if (removal && std::none_of(job->mask.begin(), job->mask.end(), [](uint8_t value) { return value != 0; })) {
                throw std::runtime_error("The selection is empty.");
            }
            std::lock_guard<std::mutex> lock(job_mutex_);
            if (busy_) throw std::runtime_error("The local backend is already generating an image.");
            if (worker_.joinable()) worker_.join();
            job_ = job;
            busy_ = true;
            worker_ = std::thread([this, job] { generate(job); });
        } catch (const std::exception& error) {
            send_json(session, {{"type", "error"}, {"id", id}, {"message", error.what()}});
        }
    }
};

int main(int argc, char** argv) {
    try {
        fs::path models = "models", config = "native/models.json";
        for (int i = 1; i + 1 < argc; i += 2) {
            if (std::string(argv[i]) == "--models") models = argv[i + 1];
            else if (std::string(argv[i]) == "--config") config = argv[i + 1];
            else throw std::runtime_error("Unknown argument.");
        }
        const char* token = std::getenv("IMGED_BACKEND_TOKEN");
        if (!token || std::strlen(token) < 32) throw std::runtime_error("IMGED_BACKEND_TOKEN must contain at least 32 characters.");
        sd_set_log_callback([](sd_log_level_t level, const char* text, void*) {
            if (level >= SD_LOG_INFO) std::cerr << text;
        }, nullptr);
        ix::initNetSystem();
        Backend backend(models, config, token);
        std::unique_ptr<ix::WebSocketServer> server;
        for (int attempt = 0; attempt < 10; ++attempt) {
            server = std::make_unique<ix::WebSocketServer>(ix::getFreePort(), "127.0.0.1");
            server->disablePerMessageDeflate();
            if (server->listen().first) break;
            server.reset();
        }
        if (!server) throw std::runtime_error("Could not bind a loopback WebSocket port.");
        server->setOnConnectionCallback([&](std::weak_ptr<ix::WebSocket> weak, std::shared_ptr<ix::ConnectionState>) {
            auto session = std::make_shared<Session>();
            session->socket = weak;
            if (auto socket = weak.lock()) socket->setOnMessageCallback([&, session](const ix::WebSocketMessagePtr& message) {
                if (message->type == ix::WebSocketMessageType::Message) backend.message(session, message->str, message->binary);
                else if (message->type == ix::WebSocketMessageType::Close || message->type == ix::WebSocketMessageType::Error) backend.cancel(session, "");
            });
        });
        server->start();
        std::cout << Json{{"type", "ready"}, {"port", server->getPort()}, {"protocol", 1}}.dump() << std::endl;
        std::string line;
        while (std::getline(std::cin, line)) { if (line == "shutdown") break; }
        backend.cancel(nullptr, "");
        server->stop();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    return 0;
}
