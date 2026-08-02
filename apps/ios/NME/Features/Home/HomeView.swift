import SwiftUI

struct HomeView: View {
    @ObservedObject var viewModel: HomeViewModel
    let onOpen: (RoomIdentity) -> Void

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    createSection
                    divider
                    joinSection
                    privacyNote
                    footer
                }
                .frame(maxWidth: 560, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 52)
                .padding(.bottom, 28)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .foregroundStyle(AppTheme.foreground)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .accessibilityHidden(true)
                Text("PRIVATE BY DESIGN")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .tracking(1.6)
                    .foregroundStyle(AppTheme.muted)
            }

            Text("NME Talk")
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .tracking(-1.2)
                .accessibilityIdentifier("productName")

            Text("Encrypted meetings the server can relay without being able to see, hear, or read them.")
                .font(.system(size: 17, weight: .regular, design: .rounded))
                .foregroundStyle(AppTheme.muted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 38)
    }

    private var createSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Start a private room")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(AppTheme.muted)

            Button {
                Task {
                    if let identity = await viewModel.createMeeting() {
                        onOpen(identity)
                    }
                }
            } label: {
                HStack(spacing: 10) {
                    if viewModel.isCreating {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "plus")
                    }
                    Text(viewModel.isCreating ? "Creating meeting…" : "New meeting")
                }
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .disabled(viewModel.isCreating)
            .accessibilityIdentifier("newMeeting")
        }
    }

    private var divider: some View {
        HStack(spacing: 14) {
            Rectangle().fill(AppTheme.border).frame(height: 1)
            Text("OR JOIN")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .tracking(1.4)
                .foregroundStyle(AppTheme.muted)
            Rectangle().fill(AppTheme.border).frame(height: 1)
        }
        .padding(.vertical, 28)
    }

    private var joinSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Meeting link")
                .font(.system(size: 14, weight: .semibold, design: .rounded))

            TextField("Paste the complete invitation", text: $viewModel.pastedLink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)
                .keyboardType(.URL)
                .submitLabel(.go)
                .onSubmit(openPastedLink)
                .padding(.horizontal, 16)
                .frame(minHeight: 50)
                .background(AppTheme.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(AppTheme.border, lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityIdentifier("meetingLinkField")

            Text("The part after # is the encryption key. It stays on your device.")
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(AppTheme.muted)

            Button("Join", action: openPastedLink)
                .buttonStyle(SecondaryActionButtonStyle())
                .disabled(!viewModel.canOpenPastedLink)
                .opacity(viewModel.canOpenPastedLink ? 1 : 0.45)
                .accessibilityIdentifier("joinPastedMeeting")

            if let issue = viewModel.presentedIssue {
                Label(issue.message, systemImage: "exclamationmark.circle.fill")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(AppTheme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("homeError")
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeOut(duration: 0.2), value: viewModel.presentedIssue)
    }

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "key.horizontal.fill")
                .foregroundStyle(AppTheme.accent)
                .accessibilityHidden(true)
            Text("Anyone with the complete link can join. Nothing is recorded, and messages disappear when the meeting ends.")
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(AppTheme.muted)
                .lineSpacing(2)
        }
        .padding(.top, 28)
    }

    private var footer: some View {
        HStack(spacing: 18) {
            Link("Privacy", destination: AppConfiguration.privacyURL)
            Link("Support", destination: AppConfiguration.supportURL)
        }
        .font(.system(size: 13, weight: .medium, design: .rounded))
        .foregroundStyle(AppTheme.muted)
        .padding(.top, 34)
    }

    private func openPastedLink() {
        if let identity = viewModel.openPastedLink() {
            onOpen(identity)
        }
    }
}
