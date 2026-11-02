/// BareKit exposes IPC endpoints only after the worklet's synchronous start.
func startWorkletIPC<IPC>(start: () -> Void, openIPC: () -> IPC?) -> IPC? {
    start()
    return openIPC()
}
