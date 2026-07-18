#!/bin/bash
set -e

echo "🚀 Setting up SSH test container for VS Code remote testing..."

# Build the image with host network to avoid IPv6 issues
echo ""
echo "📦 Building container image..."
podman build --network=host -f Dockerfile.ssh-test -t vscode-ssh-test .

# Stop and remove existing container if it exists
if podman ps -a | grep -q vscode-ssh-test; then
    echo ""
    echo "🧹 Removing existing container..."
    podman rm -f vscode-ssh-test || true
fi

# Run the container
echo ""
echo "🏃 Starting container..."
podman run -d \
  --name vscode-ssh-test \
  -p 2222:22 \
  vscode-ssh-test

# Wait for SSH to be ready
echo ""
echo "⏳ Waiting for SSH service to start..."
sleep 3

# Verify SSH is accessible
echo ""
echo "✅ Testing SSH connection..."
if timeout 5 bash -c "echo | nc -w 1 localhost 2222" 2>/dev/null; then
    echo "✅ SSH port is accessible!"
    echo "   Testing authentication..."
    sleep 2
    if sshpass -p testpass ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 testuser@localhost "echo 'SSH connection successful'" 2>/dev/null; then
        echo "✅ SSH connection verified!"
    else
        echo "⚠️  SSH connection works but authentication may need manual password entry"
        echo "   Try: ssh -p 2222 testuser@localhost (password: testpass)"
    fi
else
    echo "⚠️  SSH port check inconclusive. Try manually: ssh -p 2222 testuser@localhost"
fi

# Add SSH config if not already present
echo ""
if ! grep -q "Host vscode-ssh-test" ~/.ssh/config 2>/dev/null; then
    echo "📝 Adding SSH config to ~/.ssh/config..."
    mkdir -p ~/.ssh
    cat >> ~/.ssh/config << 'EOF'

# VS Code SSH Test Container
Host vscode-ssh-test
    HostName localhost
    Port 2222
    User testuser
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
    echo "✅ SSH config added"
else
    echo "ℹ️  SSH config already exists"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. In VS Code, press F1 and select 'Remote-SSH: Connect to Host...'"
echo "2. Select 'vscode-ssh-test'"
echo "3. Enter password: testpass"
echo "4. Install the Prompt Registry extension in the remote"
echo ""
echo "Container info:"
echo "  Name: vscode-ssh-test"
echo "  SSH: ssh -p 2222 testuser@localhost"
echo "  Password: testpass"
echo ""
echo "Useful commands:"
echo "  View logs: podman logs vscode-ssh-test"
echo "  Connect: ssh -p 2222 testuser@localhost"
echo "  Stop: podman stop vscode-ssh-test"
echo "  Restart: podman restart vscode-ssh-test"
echo "  Remove: ./scripts/cleanup-ssh-test-container.sh"
