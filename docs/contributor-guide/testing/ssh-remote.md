# Testing SSH Remote Support

This guide explains how to set up a Podman container with SSH to test the AI Primitives Hub extension in VS Code remote SSH scenarios.

## Prerequisites

- Podman installed
- VS Code with Remote-SSH extension installed
- SSH client on host machine

## Quick Start

### 1. Create SSH Test Container

Create a Dockerfile for the SSH-enabled container:

```bash
cat > Dockerfile.ssh-test << 'EOF'
FROM ubuntu:22.04

# Install SSH server and dependencies
RUN apt-get update && \
    apt-get install -y openssh-server sudo curl git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create SSH directory
RUN mkdir /var/run/sshd

# Create test user
RUN useradd -rm -d /home/testuser -s /bin/bash -g users -G sudo -u 1001 testuser && \
    echo 'testuser:testpass' | chpasswd

# Allow password authentication
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Allow root login (optional, for debugging)
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# Expose SSH port
EXPOSE 22

# Start SSH service
CMD ["/usr/sbin/sshd", "-D"]
EOF
```

### 2. Build the Container Image

```bash
podman build -f Dockerfile.ssh-test -t vscode-ssh-test .
```

### 3. Run the Container

```bash
podman run -d \
  --name vscode-ssh-test \
  -p 2222:22 \
  vscode-ssh-test
```

### 4. Verify SSH Access

```bash
ssh -p 2222 testuser@localhost
# Password: testpass
```

### 5. Configure VS Code Remote-SSH

Edit `~/.ssh/config`:

```bash
cat >> ~/.ssh/config << 'EOF'

Host vscode-ssh-test
    HostName localhost
    Port 2222
    User testuser
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
```

### 6. Connect from VS Code

1. Install "Remote - SSH" extension in VS Code
2. Press `F1` and select "Remote-SSH: Connect to Host..."
3. Select "vscode-ssh-test"
4. Enter password: `testpass`

### 7. Install Extension in Remote

Once connected:

```bash
# Build VSIX first (on host)
npm run package:vsix

# Copy to container
podman cp prompt-registry-0.0.2.vsix vscode-ssh-test:/home/testuser/

# In VS Code remote terminal
code --install-extension ~/prompt-registry-0.0.2.vsix
```

### 8. Test the Extension

1. Check `vscode.env.remoteName` - should be `'ssh-remote'`
2. Install a prompt collection
3. Check Output → "AI Primitives Hub" for logs
4. Verify prompts sync to remote filesystem

## Cleanup

```bash
podman stop vscode-ssh-test
podman rm vscode-ssh-test
podman rmi vscode-ssh-test
```

## Testing Checklist

- [ ] Container starts and SSH is accessible
- [ ] VS Code connects to SSH remote
- [ ] Extension installs in remote
- [ ] Extension activates without errors
- [ ] Can install prompt collections
- [ ] Prompts sync to remote filesystem
- [ ] No errors in Output panel
