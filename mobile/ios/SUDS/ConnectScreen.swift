import SwiftUI

struct ConnectScreen: View {
    @ObservedObject var model: ConnectionModel
    @State private var address = ""
    var body: some View {
        VStack(spacing: 20) {
            Image("AppLogo").resizable().frame(width: 96, height: 96).cornerRadius(20)
            Text("SUDS").font(.largeTitle.bold())
            Text(model.status).multilineTextAlignment(.center).foregroundColor(.secondary)
            if !model.showManual { ProgressView() }
            if model.showManual {
                TextField("https://suds.local", text: $address).textFieldStyle(.roundedBorder).keyboardType(.URL).autocapitalization(.none).disableAutocorrection(true)
                Button("Connect") { model.setServer(address) }.buttonStyle(.borderedProminent)
            }
        }.padding(28).onAppear { model.discover() }
    }
}
