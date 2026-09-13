#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

class WebSocketConnection : public std::enable_shared_from_this<WebSocketConnection> {
public:
    ~WebSocketConnection();
    void send_text(const char* data, size_t size);
    void send_binary(const uint8_t* data, size_t size);
    void close(uint16_t code, const char* reason);

private:
    friend class WebSocketServer;
    explicit WebSocketConnection(uintptr_t socket);
    bool send_frame(uint8_t opcode, const void* data, size_t size);

    uintptr_t socket_;
    std::mutex send_mutex_;
    std::atomic<bool> closed_{false};
};

struct WebSocketCallbacks {
    std::function<void(const std::shared_ptr<WebSocketConnection>&)> open;
    std::function<void(const std::shared_ptr<WebSocketConnection>&, const std::string&, bool)> message;
    std::function<void(const std::shared_ptr<WebSocketConnection>&)> close;
};

class WebSocketServer {
public:
    WebSocketServer();
    ~WebSocketServer();
    WebSocketServer(const WebSocketServer&) = delete;
    WebSocketServer& operator=(const WebSocketServer&) = delete;

    void start(WebSocketCallbacks callbacks);
    void stop();
    uint16_t port() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
