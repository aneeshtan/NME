import LiveKit
import SwiftUI

struct ParticipantTile: View {
    let participant: ParticipantSnapshot
    let track: VideoTrack?
    let mirrored: Bool
    let accessibilityText: String

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            AppTheme.surface

            if participant.isCameraEnabled, let track {
                SwiftUIVideoView(
                    track,
                    layoutMode: .fill,
                    mirrorMode: mirrored ? .mirror : .off
                )
            } else {
                fallback
            }

            LinearGradient(
                colors: [.clear, .black.opacity(0.72)],
                startPoint: .center,
                endPoint: .bottom
            )

            HStack(spacing: 7) {
                Text(participant.displayName)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .lineLimit(1)

                if participant.isLocal {
                    Text("YOU")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .tracking(0.8)
                        .foregroundStyle(AppTheme.muted)
                }

                Spacer(minLength: 4)

                Image(systemName: participant.isMicrophoneMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(participant.isMicrophoneMuted ? AppTheme.danger : .white)
                    .frame(width: 24, height: 24)
                    .background(.black.opacity(0.5), in: Circle())
                    .accessibilityHidden(true)
            }
            .padding(10)
        }
        .aspectRatio(4 / 3, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    participant.isSpeaking ? AppTheme.accent : AppTheme.border,
                    lineWidth: participant.isSpeaking ? 2 : 1
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var fallback: some View {
        ZStack {
            LinearGradient(
                colors: [AppTheme.elevated, AppTheme.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Text(initials)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.foreground)
                .frame(width: 64, height: 64)
                .background(AppTheme.border.opacity(0.72), in: Circle())
        }
    }

    private var initials: String {
        let words = participant.displayName
            .split(whereSeparator: \.isWhitespace)
            .prefix(2)
        let result = words.compactMap(\.first).map(String.init).joined()
        return result.isEmpty ? "?" : result.uppercased()
    }
}
