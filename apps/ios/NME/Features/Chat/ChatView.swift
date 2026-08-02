import SwiftUI

struct ChatView: View {
    @ObservedObject var viewModel: MeetingViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if viewModel.messages.isEmpty {
                    emptyState
                } else {
                    messages
                }
                composer
            }
            .background(AppTheme.background)
            .foregroundStyle(AppTheme.foreground)
            .navigationTitle("Encrypted chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AppTheme.accent)
                        .accessibilityIdentifier("closeChat")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "message.badge.filled.fill")
                .font(.system(size: 34, weight: .medium))
                .foregroundStyle(AppTheme.accent)
            Text("No messages yet")
                .font(.system(size: 19, weight: .bold, design: .rounded))
            Text("Messages are end-to-end encrypted, kept only on devices in this meeting, and erased when you leave.")
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(AppTheme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.messages) { message in
                        messageBubble(message)
                            .id(message.id)
                    }
                }
                .padding(16)
            }
            .onChange(of: viewModel.messages.count) { _ in
                if let id = viewModel.messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func messageBubble(_ message: PresentedChatMessage) -> some View {
        VStack(alignment: message.isLocal ? .trailing : .leading, spacing: 4) {
            Text(message.isLocal ? "You" : message.senderName)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(AppTheme.muted)
            Text(message.text)
                .font(.system(size: 15, design: .rounded))
                .textSelection(.enabled)
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(
                    message.isLocal ? AppTheme.accent : AppTheme.elevated,
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                )
                .foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: message.isLocal ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.isLocal ? "You" : message.senderName): \(message.text)")
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message", text: $viewModel.composerText, axis: .vertical)
                .lineLimit(1 ... 5)
                .textInputAutocapitalization(.sentences)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .stroke(AppTheme.border, lineWidth: 1)
                }
                .accessibilityIdentifier("chatComposer")

            Button {
                Task { await viewModel.sendMessage() }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(.white)
                    .background(AppTheme.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(viewModel.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(viewModel.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
            .accessibilityLabel("Send encrypted message")
            .accessibilityIdentifier("sendChatMessage")
        }
        .padding(12)
        .background(AppTheme.background)
        .overlay(alignment: .top) { Divider().overlay(AppTheme.border) }
    }
}
