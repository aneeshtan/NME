import SwiftUI

struct MeetingView: View {
    @ObservedObject var viewModel: MeetingViewModel
    let onLeave: () -> Void

    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var actionParticipant: ParticipantSnapshot?

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 12) {
                header
                content
                MeetingToolbar(viewModel: viewModel, onLeave: onLeave)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 6)
        }
        .foregroundStyle(AppTheme.foreground)
        .task { await viewModel.start() }
        .sheet(
            isPresented: Binding(
                get: { viewModel.isChatPresented },
                set: { viewModel.setChatPresented($0) }
            )
        ) {
            ChatView(viewModel: viewModel)
        }
        .alert(
            "Control unavailable",
            isPresented: Binding(
                get: { viewModel.controlIssue != nil },
                set: { if !$0 { viewModel.dismissControlIssue() } }
            ),
            presenting: viewModel.controlIssue
        ) { _ in
            Button("OK", role: .cancel, action: viewModel.dismissControlIssue)
        } message: { issue in
            Text(issue.message)
        }
        .confirmationDialog(
            actionParticipant.map { "Actions for \($0.displayName)" } ?? "Participant actions",
            isPresented: Binding(
                get: { actionParticipant != nil },
                set: { if !$0 { actionParticipant = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let participant = actionParticipant {
                Button("Block", role: .destructive) {
                    Task { _ = await viewModel.block(participantIdentity: participant.identity, report: false) }
                }
                Button("Block & Report", role: .destructive) {
                    Task {
                        if let report = await viewModel.block(
                            participantIdentity: participant.identity,
                            report: true
                        ) {
                            openReport(report)
                        }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(AppTheme.accent.opacity(0.15))
                Image(systemName: "lock.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(AppTheme.accent)
            }
            .frame(width: 30, height: 30)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(viewModel.statusTitle)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                Text(headerDetail)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
            }

            Spacer()

            Text(viewModel.identity.safetyNumber)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(AppTheme.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityLabel("Safety number \(viewModel.identity.safetyNumber)")
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(AppTheme.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .connected, .reconnecting:
            participantLayout
        case let .failed(failure):
            statusPanel(
                icon: "exclamationmark.triangle.fill",
                title: viewModel.statusTitle,
                detail: failureMessage(failure),
                danger: true
            )
        case .ended:
            statusPanel(
                icon: "checkmark.circle.fill",
                title: viewModel.statusTitle,
                detail: "Your local media and ephemeral messages have been cleared."
            )
        default:
            statusPanel(
                icon: stateIcon,
                title: viewModel.statusTitle,
                detail: connectingDetail
            )
        }
    }

    private var participantLayout: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let featured = viewModel.featuredParticipant {
                    tile(featured)
                        .aspectRatio(16 / 9, contentMode: .fit)
                }

                if viewModel.gridParticipants.isEmpty {
                    statusPanel(
                        icon: "person.2.fill",
                        title: "You’re connected",
                        detail: "Waiting for participant media."
                    )
                } else {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(viewModel.gridParticipants) { participant in
                            tile(participant)
                        }
                    }
                }
            }
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .animation(
            reduceMotion ? nil : .spring(response: 0.36, dampingFraction: 0.86),
            value: viewModel.orderedParticipants
        )
    }

    private var columns: [GridItem] {
        Array(
            repeating: GridItem(.flexible(), spacing: 8, alignment: .top),
            count: viewModel.gridColumnCount
        )
    }

    private func tile(_ participant: ParticipantSnapshot) -> some View {
        ParticipantTile(
            participant: participant,
            track: viewModel.videoTrack(for: participant),
            mirrored: viewModel.shouldMirror(participantIdentity: participant.identity),
            accessibilityText: viewModel.accessibilityLabel(for: participant)
        )
        .onLongPressGesture {
            guard !participant.isLocal else { return }
            actionParticipant = participant
        }
    }

    private func statusPanel(
        icon: String,
        title: String,
        detail: String,
        danger: Bool = false
    ) -> some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill((danger ? AppTheme.danger : AppTheme.accent).opacity(0.14))
                Image(systemName: icon)
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(danger ? AppTheme.danger : AppTheme.accent)
            }
            .frame(width: 72, height: 72)
            .accessibilityHidden(true)

            Text(title)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .multilineTextAlignment(.center)
            Text(detail)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(AppTheme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)

            if isBusyState {
                ProgressView().tint(AppTheme.accent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppTheme.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private var headerDetail: String {
        let count = viewModel.orderedParticipants.count
        let people = "\(count) \(count == 1 ? "participant" : "participants")"
        return viewModel.isRelayed ? "\(people) · protected relay" : people
    }

    private var stateIcon: String {
        switch viewModel.state {
        case .waitingForAdmission: "hand.raised.fill"
        case .connectingRelay: "shield.lefthalf.filled"
        default: "lock.rotation"
        }
    }

    private var connectingDetail: String {
        switch viewModel.state {
        case .waitingForAdmission:
            "This room uses a lobby. Keep the app open while the host reviews your request."
        case .connectingRelay:
            "The direct media path was blocked. Trying the deployment’s encrypted TURN relay."
        default:
            "Your room key stays on this device while the secure media path is established."
        }
    }

    private var isBusyState: Bool {
        switch viewModel.state {
        case .idle, .preparing, .waitingForAdmission, .connectingDirect, .connectingRelay:
            true
        default:
            false
        }
    }

    private func failureMessage(_ failure: MeetingFailure) -> String {
        switch failure {
        case .denied: "The host declined this admission request."
        case .noAnswer: "The lobby request expired after five minutes."
        case .relayUnavailable: "Both the direct path and protected relay are unavailable."
        case .tokenRejected: "The join permission expired or was rejected. Open the invitation again."
        case .microphonePermissionDenied: "Microphone access is off. Enable it in Settings, or join to listen only."
        case .cameraPermissionDenied: "Camera access is off. You can continue with audio only."
        case let .API(_, message): message
        case .connection: "Check your connection and try opening the invitation again."
        }
    }

    private func openReport(_ report: URL) {
        openURL(report) { accepted in
            guard !accepted else { return }
            openURL(AppConfiguration.supportURL)
        }
    }
}
