import SwiftUI

@main
struct NMEApp: App {
    @StateObject private var coordinator: AppCoordinator
    private let environment: AppEnvironment

    @MainActor
    init() {
        let environment = AppEnvironment()
        self.environment = environment
        _coordinator = StateObject(wrappedValue: environment.coordinator)
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(environment: environment, coordinator: coordinator)
                .preferredColorScheme(.dark)
        }
    }
}

private struct AppRootView: View {
    let environment: AppEnvironment
    @ObservedObject var coordinator: AppCoordinator
    @StateObject private var homeViewModel: HomeViewModel

    @MainActor
    init(environment: AppEnvironment, coordinator: AppCoordinator) {
        self.environment = environment
        self.coordinator = coordinator
        _homeViewModel = StateObject(wrappedValue: environment.makeHomeViewModel())
    }

    var body: some View {
        ZStack {
            switch coordinator.route {
            case .home:
                HomeView(viewModel: homeViewModel, onOpen: coordinator.open)
                    .transition(.opacity)
            case let .preJoin(identity):
                PreJoinFlow(
                    identity: identity,
                    environment: environment,
                    onJoin: coordinator.join,
                    onCancel: coordinator.cancelPreJoin
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            case let .meeting(identity, displayName, cameraEnabled):
                MeetingPlaceholderView(
                    identity: identity,
                    displayName: displayName,
                    cameraEnabled: cameraEnabled,
                    onLeave: coordinator.leaveMeeting
                )
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: coordinator.route)
        .onOpenURL { coordinator.open($0.absoluteString) }
        .alert(
            coordinator.presentedIssue?.title ?? "",
            isPresented: Binding(
                get: { coordinator.presentedIssue != nil },
                set: { if !$0 { coordinator.dismissIssue() } }
            ),
            presenting: coordinator.presentedIssue
        ) { _ in
            Button("OK", role: .cancel, action: coordinator.dismissIssue)
        } message: { issue in
            Text(issue.message)
        }
    }
}

private struct PreJoinFlow: View {
    @StateObject private var viewModel: PreJoinViewModel
    @StateObject private var preview: PreviewController
    let onJoin: (String, Bool) -> Void
    let onCancel: () -> Void

    @MainActor
    init(
        identity: RoomIdentity,
        environment: AppEnvironment,
        onJoin: @escaping (String, Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        _viewModel = StateObject(wrappedValue: environment.makePreJoinViewModel(identity: identity))
        _preview = StateObject(wrappedValue: environment.makePreviewController())
        self.onJoin = onJoin
        self.onCancel = onCancel
    }

    var body: some View {
        PreJoinView(
            viewModel: viewModel,
            preview: preview,
            onJoin: onJoin,
            onCancel: onCancel
        )
    }
}

private struct MeetingPlaceholderView: View {
    let identity: RoomIdentity
    let displayName: String
    let cameraEnabled: Bool
    let onLeave: () -> Void

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()
            VStack(spacing: 18) {
                ProgressView().tint(AppTheme.accent).scaleEffect(1.2)
                Text("Preparing encrypted meeting")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .accessibilityIdentifier("meetingPlaceholder")
                Text("Joining as \(displayName) · \(cameraEnabled ? "camera on" : "audio only")")
                    .font(.system(size: 14, design: .rounded))
                    .foregroundStyle(AppTheme.muted)
                Text(identity.safetyNumber)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(AppTheme.muted)
                Button("Leave", action: onLeave)
                    .buttonStyle(SecondaryActionButtonStyle())
                    .frame(maxWidth: 280)
                    .accessibilityIdentifier("leaveMeeting")
            }
            .padding(24)
        }
        .foregroundStyle(AppTheme.foreground)
    }
}
