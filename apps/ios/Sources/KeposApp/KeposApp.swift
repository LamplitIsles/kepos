import SwiftUI

@main
struct KeposApp: App {
    @State private var model = KeposScreenModel(controller: VPNController())

    var body: some Scene {
        WindowGroup { KeposView(model: model) }
    }
}
