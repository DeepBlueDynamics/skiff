#!/bin/bash
# One-shot first-boot setup: key-only SSH. Invoked via systemd.run= in cmdline.txt.
# Place on the Pi's boot partition with id_ed25519_pi.pub; see ../DEPLOYMENT.md
# Stage 1. MUST be saved with LF line endings and no UTF-8 BOM.
BOOT=/boot/firmware
[ -d "$BOOT" ] || BOOT=/boot
exec > "$BOOT/setup.log" 2>&1
set -x

configure_user() {
    local username=$1
    local user_home
    user_home=$(getent passwd "$username" | cut -d: -f6)
    [ -n "$user_home" ] || return 0
    mkdir -p "$user_home/.ssh"
    cat "$BOOT/id_ed25519_pi.pub" > "$user_home/.ssh/authorized_keys"
    chown -R "$username:$username" "$user_home/.ssh"
    chmod 700 "$user_home/.ssh"
    chmod 600 "$user_home/.ssh/authorized_keys"
    # '*' = no password exists, account NOT locked. A locked ('!') account
    # makes sshd reject even pubkey logins; a real password we don't want.
    usermod -p '*' "$username"
    # agents need sudo without a password prompt to install software
    echo "$username ALL=(ALL) NOPASSWD: ALL" > "/etc/sudoers.d/010_${username}-nopasswd"
    chmod 440 "/etc/sudoers.d/010_${username}-nopasswd"
}

if ! id -u pi >/dev/null 2>&1; then
    useradd -m -G sudo,video,audio,input -s /bin/bash pi
fi
configure_user pi

mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-key-only.conf <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF

systemctl enable ssh

# private keys never belong on the boot partition
rm -f "$BOOT/id_ed25519" "$BOOT/id_ed25519_pi"

cp "$BOOT/cmdline.normal" "$BOOT/cmdline.txt"
