#include "websocket-server.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <climits>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>
#include <winsock2.h>
#include <ws2tcpip.h>

namespace {

constexpr uintptr_t invalid_socket = static_cast<uintptr_t>(INVALID_SOCKET);
constexpr size_t max_header_size = 64 * 1024;
constexpr uint64_t max_message_size = 1024ull * 1024 * 1024;

SOCKET native_socket(uintptr_t value) { return static_cast<SOCKET>(value); }

bool receive_exact(SOCKET socket, void* target, size_t size) {
    auto* bytes = static_cast<char*>(target);
    while (size) {
        const int chunk = recv(socket, bytes, static_cast<int>(std::min<size_t>(size, INT_MAX)), 0);
        if (chunk <= 0) return false;
        bytes += chunk;
        size -= static_cast<size_t>(chunk);
    }
    return true;
}

bool send_exact(SOCKET socket, const void* source, size_t size) {
    const auto* bytes = static_cast<const char*>(source);
    while (size) {
        const int chunk = send(socket, bytes, static_cast<int>(std::min<size_t>(size, INT_MAX)), 0);
        if (chunk <= 0) return false;
        bytes += chunk;
        size -= static_cast<size_t>(chunk);
    }
    return true;
}

uint32_t rotate_left(uint32_t value, unsigned count) { return (value << count) | (value >> (32 - count)); }

std::array<uint8_t, 20> sha1(const std::string& value) {
    std::vector<uint8_t> data(value.begin(), value.end());
    const uint64_t bit_length = static_cast<uint64_t>(data.size()) * 8;
    data.push_back(0x80);
    while ((data.size() % 64) != 56) data.push_back(0);
    for (int shift = 56; shift >= 0; shift -= 8) data.push_back(static_cast<uint8_t>(bit_length >> shift));

    uint32_t h0 = 0x67452301;
    uint32_t h1 = 0xefcdab89;
    uint32_t h2 = 0x98badcfe;
    uint32_t h3 = 0x10325476;
    uint32_t h4 = 0xc3d2e1f0;
    for (size_t offset = 0; offset < data.size(); offset += 64) {
        uint32_t words[80]{};
        for (size_t index = 0; index < 16; ++index) {
            const size_t at = offset + index * 4;
            words[index] = static_cast<uint32_t>(data[at]) << 24 |
                static_cast<uint32_t>(data[at + 1]) << 16 |
                static_cast<uint32_t>(data[at + 2]) << 8 |
                data[at + 3];
        }
        for (size_t index = 16; index < 80; ++index) {
            words[index] = rotate_left(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
        }
        uint32_t a = h0;
        uint32_t b = h1;
        uint32_t c = h2;
        uint32_t d = h3;
        uint32_t e = h4;
        for (size_t index = 0; index < 80; ++index) {
            uint32_t f;
            uint32_t k;
            if (index < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (index < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (index < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            const uint32_t next = rotate_left(a, 5) + f + e + k + words[index];
            e = d;
            d = c;
            c = rotate_left(b, 30);
            b = a;
            a = next;
        }
        h0 += a;
        h1 += b;
        h2 += c;
        h3 += d;
        h4 += e;
    }

    std::array<uint8_t, 20> result{};
    const uint32_t hashes[] = {h0, h1, h2, h3, h4};
    for (size_t index = 0; index < 5; ++index) {
        result[index * 4] = static_cast<uint8_t>(hashes[index] >> 24);
        result[index * 4 + 1] = static_cast<uint8_t>(hashes[index] >> 16);
        result[index * 4 + 2] = static_cast<uint8_t>(hashes[index] >> 8);
        result[index * 4 + 3] = static_cast<uint8_t>(hashes[index]);
    }
    return result;
}

std::string base64(const uint8_t* data, size_t size) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve((size + 2) / 3 * 4);
    for (size_t index = 0; index < size; index += 3) {
        const uint32_t value = static_cast<uint32_t>(data[index]) << 16 |
            (index + 1 < size ? static_cast<uint32_t>(data[index + 1]) << 8 : 0) |
            (index + 2 < size ? data[index + 2] : 0);
        result.push_back(alphabet[(value >> 18) & 63]);
        result.push_back(alphabet[(value >> 12) & 63]);
        result.push_back(index + 1 < size ? alphabet[(value >> 6) & 63] : '=');
        result.push_back(index + 2 < size ? alphabet[value & 63] : '=');
    }
    return result;
}

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

bool perform_handshake(SOCKET socket) {
    std::string request;
    std::array<char, 4096> buffer{};
    while (request.find("\r\n\r\n") == std::string::npos) {
        const int size = recv(socket, buffer.data(), static_cast<int>(buffer.size()), 0);
        if (size <= 0) return false;
        request.append(buffer.data(), static_cast<size_t>(size));
        if (request.size() > max_header_size) return false;
    }

    std::string key;
    size_t line_start = request.find("\r\n") + 2;
    while (line_start < request.size()) {
        const size_t line_end = request.find("\r\n", line_start);
        if (line_end == std::string::npos || line_end == line_start) break;
        const std::string line = request.substr(line_start, line_end - line_start);
        const size_t separator = line.find(':');
        if (separator != std::string::npos) {
            std::string name = line.substr(0, separator);
            std::transform(name.begin(), name.end(), name.begin(), [](unsigned char value) {
                return static_cast<char>(std::tolower(value));
            });
            if (name == "sec-websocket-key") key = trim(line.substr(separator + 1));
        }
        line_start = line_end + 2;
    }
    if (key.empty()) return false;
    const auto digest = sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    const std::string response = "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + base64(digest.data(), digest.size()) + "\r\n\r\n";
    return send_exact(socket, response.data(), response.size());
}

}

WebSocketConnection::WebSocketConnection(uintptr_t socket) : socket_(socket) {}

WebSocketConnection::~WebSocketConnection() {
    if (!closed_.exchange(true)) closesocket(native_socket(socket_));
}

bool WebSocketConnection::send_frame(uint8_t opcode, const void* data, size_t size) {
    std::lock_guard<std::mutex> lock(send_mutex_);
    if (closed_) return false;
    std::array<uint8_t, 10> header{};
    size_t header_size = 2;
    header[0] = static_cast<uint8_t>(0x80 | opcode);
    if (size < 126) {
        header[1] = static_cast<uint8_t>(size);
    } else if (size <= 0xffff) {
        header[1] = 126;
        header[2] = static_cast<uint8_t>(size >> 8);
        header[3] = static_cast<uint8_t>(size);
        header_size = 4;
    } else {
        header[1] = 127;
        for (int index = 0; index < 8; ++index) header[2 + index] = static_cast<uint8_t>(static_cast<uint64_t>(size) >> (56 - index * 8));
        header_size = 10;
    }
    const SOCKET socket = native_socket(socket_);
    if (!send_exact(socket, header.data(), header_size) || (size && !send_exact(socket, data, size))) {
        closed_ = true;
        shutdown(socket, SD_BOTH);
        closesocket(socket);
        return false;
    }
    return true;
}

void WebSocketConnection::send_text(const char* data, size_t size) { send_frame(0x1, data, size); }

void WebSocketConnection::send_binary(const uint8_t* data, size_t size) { send_frame(0x2, data, size); }

void WebSocketConnection::close(uint16_t code, const char* reason) {
    std::string payload;
    payload.push_back(static_cast<char>(code >> 8));
    payload.push_back(static_cast<char>(code));
    if (reason) payload.append(reason, std::min<size_t>(std::strlen(reason), 123));
    send_frame(0x8, payload.data(), payload.size());
    if (!closed_.exchange(true)) {
        const SOCKET socket = native_socket(socket_);
        shutdown(socket, SD_BOTH);
        closesocket(socket);
    }
}

struct WebSocketServer::Impl {
    SOCKET listener = INVALID_SOCKET;
    uint16_t port = 0;
    std::atomic<bool> running{false};
    WebSocketCallbacks callbacks;
    std::thread accept_thread;
    std::mutex clients_mutex;
    std::unordered_set<std::shared_ptr<WebSocketConnection>> clients;
    std::vector<std::thread> client_threads;
    bool winsock_started = false;

    void serve(const std::shared_ptr<WebSocketConnection>& connection) {
        if (!perform_handshake(native_socket(connection->socket_))) {
            connection->close(1002, "Invalid WebSocket handshake");
        } else {
            callbacks.open(connection);
            std::string message;
            uint8_t message_opcode = 0;
            while (running && !connection->closed_) {
                uint8_t header[2];
                if (!receive_exact(native_socket(connection->socket_), header, sizeof(header))) break;
                const bool final = (header[0] & 0x80) != 0;
                const uint8_t opcode = header[0] & 0x0f;
                const bool masked = (header[1] & 0x80) != 0;
                uint64_t size = header[1] & 0x7f;
                if (!masked) break;
                if (size == 126) {
                    uint8_t extended[2];
                    if (!receive_exact(native_socket(connection->socket_), extended, sizeof(extended))) break;
                    size = static_cast<uint64_t>(extended[0]) << 8 | extended[1];
                } else if (size == 127) {
                    uint8_t extended[8];
                    if (!receive_exact(native_socket(connection->socket_), extended, sizeof(extended))) break;
                    size = 0;
                    for (uint8_t byte : extended) size = size << 8 | byte;
                }
                if (size > max_message_size || message.size() + size > max_message_size) break;
                uint8_t mask[4];
                if (!receive_exact(native_socket(connection->socket_), mask, sizeof(mask))) break;
                std::string payload(static_cast<size_t>(size), '\0');
                if (size && !receive_exact(native_socket(connection->socket_), payload.data(), payload.size())) break;
                for (size_t index = 0; index < payload.size(); ++index) payload[index] ^= static_cast<char>(mask[index % 4]);

                if (opcode == 0x8) break;
                if (opcode == 0x9) {
                    connection->send_frame(0xA, payload.data(), payload.size());
                    continue;
                }
                if (opcode == 0xA) continue;
                if (opcode == 0x1 || opcode == 0x2) {
                    message.clear();
                    message_opcode = opcode;
                } else if (opcode != 0x0 || !message_opcode) {
                    break;
                }
                message += payload;
                if (final) {
                    callbacks.message(connection, message, message_opcode == 0x2);
                    message.clear();
                    message_opcode = 0;
                }
            }
        }
        callbacks.close(connection);
        connection->close(1000, nullptr);
        std::lock_guard<std::mutex> lock(clients_mutex);
        clients.erase(connection);
    }

    void accept_connections() {
        while (running) {
            const SOCKET socket = accept(listener, nullptr, nullptr);
            if (socket == INVALID_SOCKET) {
                if (!running) break;
                continue;
            }
            auto connection = std::shared_ptr<WebSocketConnection>(new WebSocketConnection(static_cast<uintptr_t>(socket)));
            std::lock_guard<std::mutex> lock(clients_mutex);
            clients.insert(connection);
            client_threads.emplace_back([this, connection] { serve(connection); });
        }
    }
};

WebSocketServer::WebSocketServer() : impl_(std::make_unique<Impl>()) {
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw std::runtime_error("Could not initialize Winsock.");
    impl_->winsock_started = true;
}

WebSocketServer::~WebSocketServer() {
    stop();
    if (impl_->winsock_started) WSACleanup();
}

void WebSocketServer::start(WebSocketCallbacks callbacks) {
    if (impl_->running) throw std::runtime_error("WebSocket server is already running.");
    impl_->callbacks = std::move(callbacks);
    impl_->listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (impl_->listener == INVALID_SOCKET) throw std::runtime_error("Could not create the WebSocket listener.");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (bind(impl_->listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR ||
        listen(impl_->listener, SOMAXCONN) == SOCKET_ERROR) {
        closesocket(impl_->listener);
        impl_->listener = INVALID_SOCKET;
        throw std::runtime_error("Could not bind a loopback WebSocket port.");
    }
    int address_size = sizeof(address);
    if (getsockname(impl_->listener, reinterpret_cast<sockaddr*>(&address), &address_size) == SOCKET_ERROR) {
        closesocket(impl_->listener);
        impl_->listener = INVALID_SOCKET;
        throw std::runtime_error("Could not read the WebSocket listener port.");
    }
    impl_->port = ntohs(address.sin_port);
    impl_->running = true;
    impl_->accept_thread = std::thread([this] { impl_->accept_connections(); });
}

void WebSocketServer::stop() {
    if (!impl_->running.exchange(false)) return;
    if (impl_->listener != INVALID_SOCKET) {
        shutdown(impl_->listener, SD_BOTH);
        closesocket(impl_->listener);
        impl_->listener = INVALID_SOCKET;
    }
    if (impl_->accept_thread.joinable()) impl_->accept_thread.join();
    {
        std::lock_guard<std::mutex> lock(impl_->clients_mutex);
        for (const auto& connection : impl_->clients) connection->close(1001, "Server shutting down");
    }
    for (auto& thread : impl_->client_threads) if (thread.joinable()) thread.join();
    impl_->client_threads.clear();
    impl_->clients.clear();
}

uint16_t WebSocketServer::port() const { return impl_->port; }
