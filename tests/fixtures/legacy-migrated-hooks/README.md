# Superseded Hook assets

The top-level wrappers are the historical native cutover fixtures. Tests use
them to recognize old registrations or reconstruct an installed layout; they
are not shipped and must not be run with the new collector as a Node baseline.

The files in node-v1.20.0 are the original Node release wrappers copied from
loongsuite-pilot v1.20.0 at 9afbc45175c56068fad6947ca0a85c9116ce611c.
They are used only by historical Node tests. Cross-version installation tests
that claim release coverage must separately install the published archive.
