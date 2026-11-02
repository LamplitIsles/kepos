import AppKit

@main
struct KeposApp {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = VPNController()
        let menu = KeposMenuBar(control: controller)
        withExtendedLifetime((controller, menu)) { application.run() }
    }
}
