import LiveKit
import SwiftUI

struct PreJoinView: View {
    @ObservedObject var viewModel: PreJoinViewModel
    @ObservedObject var preview: PreviewController
    let onJoin: (String, Bool) -> Void
    let onCancel: () -> Void

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    heading
                    previewSurface
                    nameField
                    controls
                    safetyNumber
                    actions
                }
                .frame(maxWidth: 660)
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .foregroundStyle(AppTheme.foreground)
        .task(id: viewModel.cameraEnabled) {
            await preview.setCameraEnabled(viewModel.cameraEnabled)
        }
        .onDisappear {
            Task { await preview.stop() }
        }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Before you join")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .tracking(-0.6)
                .accessibilityIdentifier("preJoinTitle")
            Text("Check your camera, name, and safety number.")
                .font(.system(size: 15, design: .rounded))
                .foregroundStyle(AppTheme.muted)
        }
    }

    private var previewSurface: some View {
        ZStack {
            AppTheme.surface
            if let track = preview.track {
                SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .mirror)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: preview.status == .denied ? "video.slash.fill" : "video.fill")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                        .accessibilityHidden(true)
                    Text(previewMessage)
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(AppTheme.muted)
                }
            }
        }
        .aspectRatio(16 / 10, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppTheme.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(previewMessage)
    }

    private var nameField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your name")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
            TextField(
                "Guest",
                text: Binding(
                    get: { viewModel.displayName },
                    set: { viewModel.updateDisplayName($0) }
                )
            )
            .textInputAutocapitalization(.words)
            .submitLabel(.join)
            .onSubmit { join() }
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(AppTheme.surface)
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityIdentifier("displayNameField")
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Button {
                viewModel.cameraEnabled.toggle()
            } label: {
                Label(
                    cameraControlLabel,
                    systemImage: cameraControlSystemImage
                )
            }
            .buttonStyle(PreJoinControlStyle(active: cameraControlIsActive))
            .accessibilityIdentifier("cameraToggle")

            ShareLink(
                item: viewModel.shareURL,
                subject: Text("NME Talk invitation"),
                message: Text("Join my encrypted meeting")
            ) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(PreJoinControlStyle(active: false))
        }
    }

    private var safetyNumber: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SAFETY NUMBER")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .tracking(1.4)
                .foregroundStyle(AppTheme.muted)
            Text(viewModel.identity.safetyNumber)
                .font(.system(size: 16, weight: .semibold, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(AppTheme.foreground)
            Text("Compare this number aloud if you need to verify the invitation.")
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(AppTheme.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.surface)
        .overlay(alignment: .leading) {
            Rectangle().fill(AppTheme.accent).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Safety number \(viewModel.identity.safetyNumber)")
    }

    private var actions: some View {
        VStack(spacing: 8) {
            Button {
                join()
            } label: {
                HStack(spacing: 10) {
                    if viewModel.isJoining { ProgressView().tint(.white) }
                    Text(viewModel.isJoining ? "Preparing…" : "Join meeting")
                }
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .disabled(viewModel.isJoining)
            .accessibilityIdentifier("joinMeeting")

            Button("Cancel", action: onCancel)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(AppTheme.muted)
                .accessibilityIdentifier("cancelPreJoin")
        }
    }

    private var previewMessage: String {
        switch preview.status {
        case .off: "Camera off"
        case .requestingPermission: "Waiting for camera permission"
        case .starting: "Starting camera"
        case .active: "Camera preview"
        case .denied: "Camera access is off. You can still join without video."
        case .unavailable: "Camera is unavailable. You can still join without video."
        }
    }

    private var cameraControlLabel: String {
        switch preview.status {
        case .denied, .unavailable: "Camera unavailable"
        default: viewModel.cameraEnabled ? "Camera on" : "Camera off"
        }
    }

    private var cameraControlSystemImage: String {
        cameraControlIsActive ? "video.fill" : "video.slash.fill"
    }

    private var cameraControlIsActive: Bool {
        viewModel.cameraEnabled && preview.status != .denied && preview.status != .unavailable
    }

    private func join() {
        Task {
            if let result = await viewModel.prepareToJoin(preview: preview) {
                onJoin(result.displayName, result.cameraEnabled)
            }
        }
    }
}

private struct PreJoinControlStyle: ButtonStyle {
    let active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(active ? AppTheme.foreground : AppTheme.muted)
            .background(active ? AppTheme.elevated : AppTheme.surface)
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(active ? AppTheme.accent : AppTheme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.24, dampingFraction: 0.8), value: configuration.isPressed)
    }
}
