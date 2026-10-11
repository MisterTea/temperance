"""UDP/TCP DNS forwarding with a policy decision before resolution."""
import ipaddress
import socket
import socketserver
import struct


def question(packet):
    if len(packet) < 12:
        raise ValueError("Short DNS header")
    _, flags, count, _, _, _ = struct.unpack("!6H", packet[:12])
    if flags & 0xF800 or count != 1:
        raise ValueError("Only standard single-question queries are supported")
    labels, pos = [], 12
    while True:
        if pos >= len(packet):
            raise ValueError("Truncated question")
        length = packet[pos]
        pos += 1
        if length == 0:
            break
        if length > 63 or pos + length > len(packet):
            raise ValueError("Invalid label")
        labels.append(packet[pos:pos + length].decode("ascii").lower())
        pos += length
    if pos + 4 > len(packet) or pos - 12 > 255:
        raise ValueError("Invalid question length")
    if struct.unpack("!H", packet[pos + 2:pos + 4])[0] != 1:
        raise ValueError("Only Internet class is supported")
    return ".".join(labels), pos + 4


def failure(packet, code, end=None):
    if len(packet) < 12:
        return b""
    flags = 0x8080 | (struct.unpack("!H", packet[2:4])[0] & 0x0100) | code
    return packet[:2] + struct.pack("!5H", flags, int(end is not None), 0, 0, 0) + (packet[12:end] if end else b"")


def read_exact(sock, size):
    result = bytearray()
    while len(result) < size:
        chunk = sock.recv(size - len(result))
        if not chunk:
            raise OSError("Connection closed")
        result.extend(chunk)
    return bytes(result)


class Resolver:
    def __init__(self, store, upstream=("1.1.1.1", 53), networks=("127.0.0.0/8",), management_domains=()):
        self.store = store
        self.upstream = upstream
        self.networks = [ipaddress.ip_network(n) for n in networks]
        self.management_domains = frozenset(management_domains)

    def resolve(self, packet, ip, tcp=False):
        if not any(ipaddress.ip_address(ip) in n for n in self.networks):
            return failure(packet, 5)
        try:
            host, end = question(packet)
        except (ValueError, UnicodeError):
            return failure(packet, 1)
        # The control-plane hostname must resolve even when the profile is paused.
        blocked = False if host in self.management_domains else self.store.evaluate(ip, host)[0]
        if blocked:
            return failure(packet, 3, end)  # NXDOMAIN, no forged content
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as sock:
                sock.settimeout(3)
                sock.connect(self.upstream)
                if tcp:
                    sock.sendall(struct.pack("!H", len(packet)) + packet)
                    response = read_exact(sock, struct.unpack("!H", read_exact(sock, 2))[0])
                else:
                    sock.send(packet)
                    response = sock.recv(65535)
                if len(response) < 12 or response[:2] != packet[:2] or not response[2] & 0x80:
                    raise OSError("Invalid upstream reply")
                return response
        except OSError:
            return failure(packet, 2, end)


class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        response = self.server.resolver.resolve(packet, self.client_address[0])
        if response:
            sock.sendto(response, self.client_address)


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            while True:
                size = struct.unpack("!H", read_exact(self.request, 2))[0]
                response = self.server.resolver.resolve(read_exact(self.request, size), self.client_address[0], tcp=True)
                if response:
                    self.request.sendall(struct.pack("!H", len(response)) + response)
        except (OSError, ValueError):
            return


class UDPServer(socketserver.ThreadingUDPServer):
    daemon_threads = True


class TCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
