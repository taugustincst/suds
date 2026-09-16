import SwiftUI

@main
struct SUDSApp: App {
    @StateObject private var model = ConnectionModel()
    var body: some Scene {
        WindowGroup {
            if let url = model.serverURL { WebScreen(url: url, model: model) } else { ConnectScreen(model: model) }
        }
    }
}
