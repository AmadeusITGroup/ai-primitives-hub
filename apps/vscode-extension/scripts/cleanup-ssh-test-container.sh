#!/bin/bash

echo "🧹 Cleaning up SSH test container..."

# Stop container
if podman ps | grep -q vscode-ssh-test; then
    echo "⏹️  Stopping container..."
    podman stop vscode-ssh-test
fi

# Remove container
if podman ps -a | grep -q vscode-ssh-test; then
    echo "🗑️  Removing container..."
    podman rm vscode-ssh-test
fi

# Remove image
if podman images | grep -q vscode-ssh-test; then
    echo "🗑️  Removing image..."
    podman rmi vscode-ssh-test
fi

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "Note: SSH config in ~/.ssh/config was not removed."
echo "To remove it manually, edit ~/.ssh/config and delete the vscode-ssh-test section."
