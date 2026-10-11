"""Compatibility fixes for the pinned upstream package on modern Xcode."""
from pathlib import Path
root = Path(__file__).parent / 'Vendor/wireguard-apple'
p = root / 'Package.swift'
p.write_text(p.read_text().replace('swift-tools-version:5.3', 'swift-tools-version:5.5'))
p = root / 'Sources/WireGuardKitC/WireGuardKitC.h'
s = p.read_text()
if '#include <sys/types.h>' not in s:
    p.write_text('#include <sys/types.h>\n' + s)
