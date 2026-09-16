import SwiftUI

@main
struct SUDSApp: App {
    @StateObject private var model = ConnectionModel()
    var body: some Scene { WindowGroup { WebScreen(model: model) } }
}
