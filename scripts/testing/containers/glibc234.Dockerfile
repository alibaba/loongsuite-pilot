FROM quay.io/rockylinux/rockylinux@sha256:ed654c694190a670bb5c33f68995b862214fc96ffbdca95e07a8935ba0a3717d
RUN dnf install -y gcc gcc-c++ make pkgconf-pkg-config python3 perl tar gzip git ca-certificates procps-ng && dnf clean all
