import SwiftUI

struct MeetingToolbar: View {
    @ObservedObject var viewModel: MeetingViewModel
    let onLeave: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            control(
                title: viewModel.microphoneEnabled ? "Mute" : "Unmute",
                systemImage: viewModel.microphoneEnabled ? "mic.fill" : "mic.slash.fill",
                active: viewModel.microphoneEnabled,
                disabled: viewModel.isMicrophoneBusy
            ) {
                Task { await viewModel.toggleMicrophone() }
            }
            .accessibilityIdentifier("microphoneToggle")

            control(
                title: viewModel.cameraEnabled ? "Camera" : "Camera off",
                systemImage: viewModel.cameraEnabled ? "video.fill" : "video.slash.fill",
                active: viewModel.cameraEnabled,
                disabled: viewModel.isCameraBusy
            ) {
                Task { await viewModel.toggleCamera() }
            }
            .accessibilityIdentifier("meetingCameraToggle")

            control(
                title: "Flip",
                systemImage: "arrow.triangle.2.circlepath.camera.fill",
                active: false,
                disabled: !viewModel.cameraEnabled || viewModel.isFlipBusy
            ) {
                Task { await viewModel.flipCamera() }
            }
            .accessibilityIdentifier("flipCamera")

            control(
                title: "Chat",
                systemImage: "message.fill",
                active: viewModel.isChatPresented,
                disabled: false
            ) {
                viewModel.setChatPresented(true)
            }
            .overlay(alignment: .topTrailing) {
                if viewModel.unreadCount > 0 {
                    Text(viewModel.unreadCount > 99 ? "99+" : "\(viewModel.unreadCount)")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(AppTheme.danger, in: Capsule())
                        .offset(x: 2, y: -2)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityLabel(
                viewModel.unreadCount > 0
                    ? "Chat, \(viewModel.unreadCount) unread messages"
                    : "Chat"
            )
            .accessibilityIdentifier("openChat")

            control(
                title: "Leave",
                systemImage: "phone.down.fill",
                active: false,
                disabled: false,
                danger: true
            ) {
                Task {
                    await viewModel.leave()
                    onLeave()
                }
            }
            .accessibilityIdentifier("leaveMeeting")
        }
        .padding(8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppTheme.border.opacity(0.8), lineWidth: 1)
        }
    }

    private func control(
        title: String,
        systemImage: String,
        active: Bool,
        disabled: Bool,
        danger: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .semibold))
                    .frame(height: 20)
                Text(title)
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(danger ? .white : active ? AppTheme.foreground : AppTheme.muted)
            .background(
                danger ? AppTheme.danger : active ? AppTheme.elevated : AppTheme.surface,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }
}
