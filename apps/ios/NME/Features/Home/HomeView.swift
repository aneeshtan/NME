import SwiftUI

struct HomeView: View {
    var body: some View {
        ZStack {
            Color(red: 11 / 255, green: 13 / 255, blue: 16 / 255)
                .ignoresSafeArea()
            Text("NME Talk")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)
                .accessibilityIdentifier("productName")
        }
    }
}

#Preview {
    HomeView()
        .preferredColorScheme(.dark)
}

