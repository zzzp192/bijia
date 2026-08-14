// Wire protocol for the 1688 daemon. Newline-delimited JSON over a Unix socket
// on macOS/Linux or a named pipe on Windows.
export function makeRequestId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
//# sourceMappingURL=protocol.js.map