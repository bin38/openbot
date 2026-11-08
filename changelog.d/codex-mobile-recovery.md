### Fixed

- Allow the independent phone connection launcher to recover from a confirmed stopped process without deleting earlier lock records. Refuse recovery while a launcher, recorded child or service port is still active.
- Record which phone connection service stopped and its exit status, without recording child output or credentials.
