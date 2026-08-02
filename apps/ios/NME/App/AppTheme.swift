import SwiftUI

enum AppTheme {
    static let background = Color(red: 11 / 255, green: 13 / 255, blue: 16 / 255)
    static let surface = Color(red: 20 / 255, green: 23 / 255, blue: 28 / 255)
    static let elevated = Color(red: 28 / 255, green: 32 / 255, blue: 39 / 255)
    static let border = Color(red: 39 / 255, green: 44 / 255, blue: 53 / 255)
    static let foreground = Color(red: 232 / 255, green: 234 / 255, blue: 237 / 255)
    static let muted = Color(red: 154 / 255, green: 162 / 255, blue: 173 / 255)
    static let accent = Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255)
    static let danger = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
}

struct PrimaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(.white)
            .background(AppTheme.accent)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.24, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

struct SecondaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(AppTheme.foreground)
            .background(AppTheme.elevated)
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(.spring(response: 0.24, dampingFraction: 0.8), value: configuration.isPressed)
    }
}
