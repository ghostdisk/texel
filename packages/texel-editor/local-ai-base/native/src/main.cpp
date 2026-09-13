#include <ixwebsocket/IXGetFreePort.h>
#include <ixwebsocket/IXWebSocketServer.h>
#include <texel-local-ai-backend.h>
#include <atomic>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <windows.h>

namespace fs = std::filesystem;

struct HostState {
    std::mutex mutex;
    std::unordered_map<uint64_t, std::weak_ptr<ix::WebSocket>> sessions;
};

static void TEXEL_LOCAL_AI_CALL send_text(void* user, uint64_t session, const char* data, size_t size) {
    auto& state = *static_cast<HostState*>(user);
    std::shared_ptr<ix::WebSocket> socket;
    {
        std::lock_guard<std::mutex> lock(state.mutex);
        socket = state.sessions[session].lock();
    }
    if (socket) socket->send(std::string(data, size));
}

static void TEXEL_LOCAL_AI_CALL send_binary(void* user, uint64_t session, const uint8_t* data, size_t size) {
    auto& state = *static_cast<HostState*>(user);
    std::shared_ptr<ix::WebSocket> socket;
    {
        std::lock_guard<std::mutex> lock(state.mutex);
        socket = state.sessions[session].lock();
    }
    if (socket) socket->sendBinary(std::string(reinterpret_cast<const char*>(data), size));
}

static void TEXEL_LOCAL_AI_CALL close_session(void* user, uint64_t session, uint16_t code, const char* reason) {
    auto& state = *static_cast<HostState*>(user);
    std::shared_ptr<ix::WebSocket> socket;
    {
        std::lock_guard<std::mutex> lock(state.mutex);
        socket = state.sessions[session].lock();
    }
    if (socket) socket->close(code, reason ? reason : "");
}

static void TEXEL_LOCAL_AI_CALL log_message(void*, const char* data, size_t size) {
    std::cerr.write(data, static_cast<std::streamsize>(size));
    if (!size || data[size - 1] != '\n') std::cerr << '\n';
}

class LoadedBackend {
    HMODULE module_ = nullptr;
    const TexelLocalAiBackend* api_ = nullptr;
    void* instance_ = nullptr;

public:
    LoadedBackend(const fs::path& library, const TexelLocalAiHost& host, const TexelLocalAiConfig& config) {
        module_ = LoadLibraryW(library.c_str());
        if (!module_) throw std::runtime_error("Could not load local AI backend: " + library.string());
        const auto entry = reinterpret_cast<TexelLocalAiBackendEntry>(GetProcAddress(module_, "texel_local_ai_backend"));
        if (!entry || !(api_ = entry()) || api_->abi_version != TEXEL_LOCAL_AI_ABI_VERSION) {
            throw std::runtime_error("The local AI backend ABI is incompatible.");
        }
        char error[1024]{};
        instance_ = api_->create(&host, &config, error, sizeof(error));
        if (!instance_) throw std::runtime_error(error[0] ? error : "The local AI backend could not start.");
    }

    ~LoadedBackend() {
        if (instance_) api_->destroy(instance_);
        if (module_) FreeLibrary(module_);
    }

    void connect(uint64_t session) const { api_->connect(instance_, session); }
    void disconnect(uint64_t session) const { api_->disconnect(instance_, session); }
    void message(uint64_t session, const std::string& data, bool binary) const {
        api_->message(instance_, session, reinterpret_cast<const uint8_t*>(data.data()), data.size(), binary);
    }
};

int main(int argc, char** argv) {
    try {
        fs::path library;
        fs::path models = "models";
        fs::path config = "models.json";
        for (int index = 1; index + 1 < argc; index += 2) {
            const std::string argument = argv[index];
            if (argument == "--backend") library = argv[index + 1];
            else if (argument == "--models") models = argv[index + 1];
            else if (argument == "--config") config = argv[index + 1];
            else throw std::runtime_error("Unknown local AI host argument: " + argument);
        }
        if (library.empty()) throw std::runtime_error("A local AI backend DLL is required.");

        HostState state;
        const TexelLocalAiHost host{
            TEXEL_LOCAL_AI_ABI_VERSION,
            &state,
            send_text,
            send_binary,
            close_session,
            log_message,
        };
        const auto model_root = models.string();
        const auto model_config = config.string();
        const TexelLocalAiConfig backend_config{
            TEXEL_LOCAL_AI_ABI_VERSION,
            model_root.c_str(),
            model_config.c_str(),
        };
        LoadedBackend backend(library, host, backend_config);

        ix::initNetSystem();
        std::unique_ptr<ix::WebSocketServer> server;
        for (int attempt = 0; attempt < 10; ++attempt) {
            server = std::make_unique<ix::WebSocketServer>(ix::getFreePort(), "127.0.0.1");
            server->disablePerMessageDeflate();
            if (server->listen().first) break;
            server.reset();
        }
        if (!server) throw std::runtime_error("Could not bind a loopback WebSocket port.");

        std::atomic<uint64_t> next_session{1};
        server->setOnConnectionCallback([&](std::weak_ptr<ix::WebSocket> weak, std::shared_ptr<ix::ConnectionState>) {
            const uint64_t session = next_session.fetch_add(1);
            {
                std::lock_guard<std::mutex> lock(state.mutex);
                state.sessions[session] = weak;
            }
            backend.connect(session);
            if (auto socket = weak.lock()) socket->setOnMessageCallback([&, session](const ix::WebSocketMessagePtr& message) {
                if (message->type == ix::WebSocketMessageType::Message) {
                    backend.message(session, message->str, message->binary);
                } else if (message->type == ix::WebSocketMessageType::Close ||
                    message->type == ix::WebSocketMessageType::Error) {
                    backend.disconnect(session);
                    std::lock_guard<std::mutex> lock(state.mutex);
                    state.sessions.erase(session);
                }
            });
        });
        server->start();
        std::cout << "{\"type\":\"ready\",\"port\":" << server->getPort()
                  << ",\"protocol\":1}" << std::endl;
        std::string line;
        while (std::getline(std::cin, line) && line != "shutdown") {}
        server->stop();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    return 0;
}
