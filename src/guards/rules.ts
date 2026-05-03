/**
 * Destructive-command classifier rules.
 *
 * IMPORTANT FRAMING (per plan v4.2 §"Phase 3 expansion — Sandbox-first"):
 * The classifier is a TRIPWIRE that catches the obviously-careless agent. It is
 * NOT a security control. Real security comes from running the bash tool inside
 * an OS-level sandbox (bwrap / sandbox-exec / AppContainer). See SECURITY.md
 * and tests/classifier-known-limitations.test.ts for documented bypass classes.
 *
 * Rules are evaluated by src/guards/classifier.ts in this order:
 *   1. Regex match on the full command string.
 *   2. AST decomposition (pipelines, sequences, subshells) — recurse on each
 *      atomic sub-command.
 *   3. Strictest matching decision wins; layered findings collected for audit.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Decision = "allow" | "confirm" | "block";

export interface Rule {
  id: string; // unique, e.g. 'critical-fs-wipe-rm-rf-root'
  severity: Severity;
  pattern: RegExp; // case-insensitive where appropriate
  description: string;
  decision: Decision; // critical/high → 'confirm'; low → 'allow' (warn-only)
  category: string; // grouping for tests/reporting
}

// --------------------------------------------------------------------------
// CRITICAL — irreversible filesystem / OS / privilege-escalation operations
// --------------------------------------------------------------------------

const CRITICAL_FS_WIPE: Rule[] = [
  {
    id: "critical-fs-wipe-rm-rf-root",
    severity: "critical",
    // rm -rf / (and -fr / -Rf / etc.), but NOT rm -rf /tmp/anything
    pattern: /\brm\s+-[rRf]+\s+\/(?!tmp\b|var\/tmp\b|var\/folders\b)/i,
    description: "rm -rf targeting / or system path (not /tmp)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-rm-rf-home-tilde",
    severity: "critical",
    // rm -rf ~ / rm -rf "~" / rm -rf '~'
    pattern: /\brm\s+-[rRf]+\s+["']?~/,
    description: "rm -rf targeting home (~) directory",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-find-delete",
    severity: "critical",
    pattern: /\bfind\s+\S.*-delete\b/i,
    description: "find … -delete (recursive deletion)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-dd-of-dev",
    severity: "critical",
    pattern: /\bdd\s+if=\S+\s+of=\/dev\//i,
    description: "dd writing to /dev/* (raw disk write)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-mkfs",
    severity: "critical",
    pattern: /\bmkfs\.[a-z0-9]+\b/i,
    description: "mkfs.* (filesystem creation = destroys data)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-format-drive",
    severity: "critical",
    pattern: /\bformat\s+[A-Za-z]:/i,
    description: "format <drive>: (Windows drive format)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-windows-del-drive",
    severity: "critical",
    pattern: /\bdel\s+(?:\/[FQSfqs]\s+)+[A-Za-z]:/i,
    description: "del /F /Q /S <drive>: (recursive force delete)",
    decision: "confirm",
    category: "fs-wipe",
  },
  {
    id: "critical-fs-wipe-windows-rmdir-drive",
    severity: "critical",
    pattern: /\brmdir\s+\/s\s+\/q\s+[A-Za-z]:/i,
    description: "rmdir /s /q <drive>: (recursive force directory wipe)",
    decision: "confirm",
    category: "fs-wipe",
  },
];

const CRITICAL_OS_PARTITION: Rule[] = [
  {
    id: "critical-os-partition-write-etc",
    severity: "critical",
    // Match writes (rm/mv/cp/echo > / tee / chmod / chown / >) targeting any
    // path under sensitive trees. Path may appear anywhere in the command.
    pattern:
      /\b(?:rm|mv|cp|tee|chmod|chown|sed\s+-i)\b[^|;&\n]*?(?:\/etc\/|\/usr\/(?!local\/)|\/System\/|\/boot\/|\/private\/var\/db\/)/i,
    description: "write/modify under /etc /usr /System /boot /private/var/db",
    decision: "confirm",
    category: "os-partition",
  },
  {
    id: "critical-os-partition-redirect-etc",
    severity: "critical",
    // shell redirection (>, >>) targeting a sensitive path
    pattern:
      />>?\s*(?:\/etc\/|\/usr\/(?!local\/)|\/System\/|\/boot\/|\/private\/var\/db\/)/,
    description: "redirect into /etc /usr /System /boot /private/var/db",
    decision: "confirm",
    category: "os-partition",
  },
  {
    id: "critical-os-partition-write-windows",
    severity: "critical",
    pattern:
      /(?:[A-Za-z]:\\Windows\\|\\Windows\\System32\\)|\bC:\\Windows\b/i,
    description: "write/modify under C:\\Windows",
    decision: "confirm",
    category: "os-partition",
  },
];

// Match a binary at command position. Either at start-of-string, or
// preceded by a shell separator (space allowed), and followed by a
// real word terminator — NOT a hyphen (so `sudo-was-here` won't match).
const PRIVESC_WORD = (name: string): RegExp =>
  new RegExp(`(?:^|[\\s;&|(])${name}(?=\\s|$|;|&|\\||\\))`);

const CRITICAL_PRIV_ESC: Rule[] = [
  {
    id: "critical-privesc-sudo",
    severity: "critical",
    pattern: PRIVESC_WORD("sudo"),
    description: "sudo (privilege escalation)",
    decision: "confirm",
    category: "priv-esc",
  },
  {
    id: "critical-privesc-doas",
    severity: "critical",
    pattern: PRIVESC_WORD("doas"),
    description: "doas (privilege escalation)",
    decision: "confirm",
    category: "priv-esc",
  },
  {
    id: "critical-privesc-runas",
    severity: "critical",
    pattern: /\brunas\s+\/user:/i,
    description: "runas /user: (Windows privilege escalation)",
    decision: "confirm",
    category: "priv-esc",
  },
  {
    id: "critical-privesc-su",
    severity: "critical",
    pattern: PRIVESC_WORD("su"),
    description: "su (substitute user)",
    decision: "confirm",
    category: "priv-esc",
  },
  {
    id: "critical-privesc-chown-root",
    severity: "critical",
    pattern: /\bchown\s+\S*root[:\s]/i,
    description: "chown … root: (escalate ownership)",
    decision: "confirm",
    category: "priv-esc",
  },
];

const CRITICAL_BOOTLOADER: Rule[] = [
  {
    id: "critical-bootloader-efibootmgr",
    severity: "critical",
    pattern: /\befibootmgr\b/i,
    description: "efibootmgr (UEFI boot configuration)",
    decision: "confirm",
    category: "bootloader",
  },
  {
    id: "critical-bootloader-bcdedit",
    severity: "critical",
    pattern: /\bbcdedit\b/i,
    description: "bcdedit (Windows boot configuration)",
    decision: "confirm",
    category: "bootloader",
  },
  {
    id: "critical-bootloader-grub-install",
    severity: "critical",
    pattern: /\bgrub-install\b/i,
    description: "grub-install (GRUB bootloader install)",
    decision: "confirm",
    category: "bootloader",
  },
  {
    id: "critical-bootloader-firmware",
    severity: "critical",
    pattern: /\bfirmware(?:[-_]?(?:update|flash|write))\b/i,
    description: "firmware update / flash",
    decision: "confirm",
    category: "bootloader",
  },
  {
    id: "critical-bootloader-nvram",
    severity: "critical",
    pattern: /\bnvram\s+(?:-d|-c|-f)\b/i,
    description: "nvram modification",
    decision: "confirm",
    category: "bootloader",
  },
];

const CRITICAL_WINDOWS_DESTRUCT: Rule[] = [
  {
    id: "critical-windows-cipher-w",
    severity: "critical",
    pattern: /\bcipher\s+\/w\b/i,
    description: "cipher /w (overwrite free disk space)",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-manage-bde",
    severity: "critical",
    pattern: /\bmanage-bde\b.*-(?:off|disable)\b/i,
    description: "manage-bde -off/-disable (decrypt BitLocker)",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-disable-bitlocker",
    severity: "critical",
    pattern: /\bDisable-BitLocker\b/i,
    description: "Disable-BitLocker",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-format-volume",
    severity: "critical",
    pattern: /\bFormat-Volume\b/i,
    description: "Format-Volume PowerShell cmdlet",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-clear-disk",
    severity: "critical",
    pattern: /\bClear-Disk\b/i,
    description: "Clear-Disk PowerShell cmdlet",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-remove-partition",
    severity: "critical",
    pattern: /\bRemove-Partition\b/i,
    description: "Remove-Partition PowerShell cmdlet",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-reset-physicaldisk",
    severity: "critical",
    pattern: /\bReset-PhysicalDisk\b/i,
    description: "Reset-PhysicalDisk PowerShell cmdlet",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-wevtutil-cl",
    severity: "critical",
    pattern: /\bwevtutil\s+cl\b/i,
    description: "wevtutil cl (clear event log = forensic destruction)",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-vssadmin-delete",
    severity: "critical",
    pattern: /\bvssadmin\s+delete\s+shadows?\b/i,
    description: "vssadmin delete shadows (destroy shadow copies)",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-wbadmin-delete",
    severity: "critical",
    pattern: /\bwbadmin\s+delete\s+catalog\b/i,
    description: "wbadmin delete catalog (destroy backup catalog)",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-wmic-shadowcopy",
    severity: "critical",
    pattern: /\bwmic\s+shadowcopy\s+delete\b/i,
    description: "wmic shadowcopy delete",
    decision: "confirm",
    category: "windows-destruct",
  },
  {
    id: "critical-windows-diskpart",
    severity: "critical",
    pattern: /\bdiskpart\b/i,
    description: "diskpart (interactive disk partitioning)",
    decision: "confirm",
    category: "windows-destruct",
  },
];

const CRITICAL_INTERPRETER: Rule[] = [
  {
    id: "critical-interpreter-bash-c",
    severity: "critical",
    pattern: /\bbash\s+-c\b/,
    description: "bash -c <script> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-sh-c",
    severity: "critical",
    pattern: /\bsh\s+-c\b/,
    description: "sh -c <script> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-zsh-c",
    severity: "critical",
    pattern: /\bzsh\s+-c\b/,
    description: "zsh -c <script> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-eval",
    severity: "critical",
    pattern: /(?:^|[\s;&|(])eval\s/,
    description: "eval — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-python-c",
    severity: "critical",
    pattern: /\bpython3?\s+-c\b/,
    description: "python -c <code> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-node-e",
    severity: "critical",
    pattern: /\bnode\s+-e\b/,
    description: "node -e <code> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-perl-e",
    severity: "critical",
    pattern: /\bperl\s+-e\b/,
    description: "perl -e <code> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-ruby-e",
    severity: "critical",
    pattern: /\bruby\s+-e\b/,
    description: "ruby -e <code> — opaque payload defeats classifier",
    decision: "confirm",
    category: "interpreter",
  },
  {
    id: "critical-interpreter-source",
    severity: "critical",
    // source /path  OR  . /path  (sourcing arbitrary file)
    pattern: /(?:^|[\s;&|(])(?:source|\.)\s+\/(?!proc\/)/,
    description: "source/dot loading file outside /proc — opaque payload",
    decision: "confirm",
    category: "interpreter",
  },
];

const CRITICAL_SHELL_LIKE_TOOL: Rule[] = [
  {
    id: "critical-git-config-alias",
    severity: "critical",
    // git config [--global] alias.X — could install malicious alias
    pattern: /\bgit\s+config\b[^;|&\n]*\balias\./i,
    description: "git config alias.* — malicious alias install vector",
    decision: "confirm",
    category: "shell-like-tool",
  },
  {
    id: "critical-npm-run-arbitrary",
    severity: "critical",
    // npm run NOT-allowlisted — package.json scripts can be anything
    pattern:
      /\bnpm\s+run\s+(?!install\b|test\b|lint\b|format\b|build\b|typecheck\b|check\b)\S/,
    description:
      "npm run <non-allowlisted> — package.json script can be anything",
    decision: "confirm",
    category: "shell-like-tool",
  },
  {
    id: "critical-pnpm-run-arbitrary",
    severity: "critical",
    pattern:
      /\bpnpm\s+run\s+(?!install\b|test\b|lint\b|format\b|build\b|typecheck\b|check\b)\S/,
    description: "pnpm run <non-allowlisted> — script can be anything",
    decision: "confirm",
    category: "shell-like-tool",
  },
  {
    id: "critical-yarn-run-arbitrary",
    severity: "critical",
    pattern:
      /\byarn\s+run\s+(?!install\b|test\b|lint\b|format\b|build\b|typecheck\b|check\b)\S/,
    description: "yarn run <non-allowlisted> — script can be anything",
    decision: "confirm",
    category: "shell-like-tool",
  },
  {
    id: "critical-make-arbitrary",
    severity: "critical",
    // make NOT-allowlisted — Makefile recipes can be anything
    pattern:
      /\bmake\s+(?!check\b|test\b|lint\b|format\b|build\b|all\b|clean\b\s*$|-)\S/,
    description: "make <non-allowlisted> — Makefile recipe can be anything",
    decision: "confirm",
    category: "shell-like-tool",
  },
];

const CRITICAL_PATH_RELATIVE: Rule[] = [
  {
    id: "critical-path-relative-rm-home-var",
    severity: "critical",
    pattern: /\brm\s+-[rRf]+\s+["']?\$HOME\b/,
    description: "rm -rf $HOME",
    decision: "confirm",
    category: "path-relative",
  },
  {
    id: "critical-path-relative-find-home",
    severity: "critical",
    pattern: /\bfind\s+["']?\$HOME\b/,
    description: "find $HOME",
    decision: "confirm",
    category: "path-relative",
  },
];

const CRITICAL_UNICODE_TRICK: Rule[] = [
  {
    id: "critical-unicode-rm-dash-trick",
    severity: "critical",
    // rm followed by Unicode hyphen variants (en-dash, em-dash, hyphen, minus, fig-dash)
    // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
    // U+2013 en-dash, U+2014 em-dash, U+2212 minus
    pattern: /\brm[‐‑‒–—−]rf\b/u,
    description: "rm with Unicode dash variants instead of ASCII hyphen",
    decision: "confirm",
    category: "unicode-trick",
  },
  {
    id: "critical-unicode-rm-dash-trick-spaced",
    severity: "critical",
    // rm <unicode-dash>rf …
    pattern:
      /\brm\s+[‐‑‒–—−](?:[rRf]+)\s/u,
    description:
      "rm with Unicode dash flag (e.g. rm –rf) — fools naive parsers",
    decision: "confirm",
    category: "unicode-trick",
  },
];

// --------------------------------------------------------------------------
// HIGH — recoverable but expensive / data-loss-shaped operations
// --------------------------------------------------------------------------

const HIGH_GIT_REWRITE: Rule[] = [
  {
    id: "high-git-push-force",
    severity: "high",
    pattern: /\bgit\s+push\s+(?:.*\s)?(?:-f|--force(?:-with-lease)?)\b/,
    description: "git push --force — destroys remote history",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-filter-branch",
    severity: "high",
    pattern: /\bgit\s+filter-(?:branch|repo)\b/,
    description: "git filter-branch / filter-repo — rewrites history",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-reset-hard",
    severity: "high",
    pattern: /\bgit\s+reset\s+(?:.*\s)?--hard\b/,
    description: "git reset --hard — discards uncommitted changes",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-reflog-expire",
    severity: "high",
    pattern: /\bgit\s+reflog\s+expire\b/,
    description: "git reflog expire — destroys recovery breadcrumbs",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-gc-prune",
    severity: "high",
    pattern: /\bgit\s+gc\s+(?:.*\s)?--prune\b/,
    description: "git gc --prune — removes unreferenced objects",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-update-ref-d",
    severity: "high",
    pattern: /\bgit\s+update-ref\s+-d\b/,
    description: "git update-ref -d — deletes ref",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-branch-delete-force",
    severity: "high",
    pattern: /\bgit\s+branch\s+-D\b/,
    description: "git branch -D — force-delete branch",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-clean-fd",
    severity: "high",
    pattern: /\bgit\s+clean\s+-[fdx]+\b/,
    description: "git clean -fd / -fdx — deletes untracked files",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-rebase-interactive",
    severity: "high",
    pattern: /\bgit\s+rebase\s+(?:-i|--interactive)\b/,
    description: "git rebase -i — interactive history rewrite",
    decision: "confirm",
    category: "git-rewrite",
  },
  {
    id: "high-git-stash-drop-clear",
    severity: "high",
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/,
    description: "git stash drop/clear — discards stashed changes",
    decision: "confirm",
    category: "git-rewrite",
  },
];

const HIGH_DB_WIPE: Rule[] = [
  {
    id: "high-db-drop-database",
    severity: "high",
    pattern: /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i,
    description: "DROP DATABASE/SCHEMA/TABLE",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-truncate-table",
    severity: "high",
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    description: "TRUNCATE TABLE",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-dropdb",
    severity: "high",
    pattern: /\bdropdb\b/i,
    description: "dropdb (PostgreSQL drop database)",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-redis-flush",
    severity: "high",
    pattern: /\bredis-cli\b.*\b(?:FLUSHDB|FLUSHALL)\b/i,
    description: "redis-cli FLUSHDB/FLUSHALL",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-mongo-drop",
    severity: "high",
    pattern: /\bmongo\b.*\bdb\.dropDatabase\s*\(/i,
    description: "mongo db.dropDatabase()",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-pg-drop",
    severity: "high",
    pattern: /\bpg_drop\w*\b/i,
    description: "pg_drop* family",
    decision: "confirm",
    category: "db-wipe",
  },
  {
    id: "high-db-mysqladmin-drop",
    severity: "high",
    pattern: /\bmysqladmin\s+drop\b/i,
    description: "mysqladmin drop",
    decision: "confirm",
    category: "db-wipe",
  },
];

const HIGH_RECURSIVE_PERMS: Rule[] = [
  {
    id: "high-perms-chmod-r",
    severity: "high",
    pattern: /\bchmod\s+(?:.*\s)?-R\b/,
    description: "chmod -R — recursive permission change",
    decision: "confirm",
    category: "recursive-perms",
  },
  {
    id: "high-perms-chown-r",
    severity: "high",
    pattern: /\bchown\s+(?:.*\s)?-R\b/,
    description: "chown -R — recursive ownership change",
    decision: "confirm",
    category: "recursive-perms",
  },
  {
    id: "high-perms-setfacl-r",
    severity: "high",
    pattern: /\bsetfacl\s+(?:.*\s)?-R\b/,
    description: "setfacl -R — recursive ACL change",
    decision: "confirm",
    category: "recursive-perms",
  },
  {
    id: "high-perms-icacls-t",
    severity: "high",
    pattern: /\bicacls\b.*\s\/T\b/i,
    description: "icacls … /T — recursive Windows ACL change",
    decision: "confirm",
    category: "recursive-perms",
  },
];

const HIGH_CLOUD_DELETE: Rule[] = [
  {
    id: "high-cloud-aws-delete",
    severity: "high",
    // Match aws <subcmd>... <verb> where verb ∈ {delete-*, destroy, terminate-*}.
    // Allow any number of intermediate tokens.
    pattern: /\baws\b[^|;&\n]*?\b(?:delete\S*|destroy\S*|terminate\S*)\b/i,
    description: "aws … delete/destroy/terminate",
    decision: "confirm",
    category: "cloud-delete",
  },
  {
    id: "high-cloud-gcloud-delete",
    severity: "high",
    pattern: /\bgcloud\b[^|;&\n]*?\bdelete\b/i,
    description: "gcloud … delete",
    decision: "confirm",
    category: "cloud-delete",
  },
  {
    id: "high-cloud-az-delete",
    severity: "high",
    pattern: /\baz\b[^|;&\n]*?\bdelete\b/i,
    description: "az … delete (Azure CLI)",
    decision: "confirm",
    category: "cloud-delete",
  },
  {
    id: "high-cloud-terraform-destroy",
    severity: "high",
    pattern: /\bterraform\s+destroy\b/i,
    description: "terraform destroy",
    decision: "confirm",
    category: "cloud-delete",
  },
  {
    id: "high-cloud-kubectl-delete",
    severity: "high",
    pattern:
      /\bkubectl\s+delete\s+(?:ns|namespace|pv|pvc|deployment|statefulset)\b/i,
    description: "kubectl delete ns/pv/pvc/deployment/statefulset",
    decision: "confirm",
    category: "cloud-delete",
  },
];

const HIGH_CRED_FILE: Rule[] = [
  {
    id: "high-cred-mod-ssh-aws-etc",
    severity: "high",
    pattern:
      /\b(?:rm|mv|cp|tee|chmod|chown|sed\s+-i)\b[^|;&\n]*?~\/\.(?:ssh\/|aws\/|gnupg\/|kube\/|docker\/config\.json|config\/sergio-keys\/|netrc\b|gitconfig\b)/,
    description:
      "write/delete under ~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.docker/config.json ~/.config/sergio-keys ~/.netrc ~/.gitconfig",
    decision: "confirm",
    category: "cred-file",
  },
  {
    id: "high-cred-redirect-ssh-aws-etc",
    severity: "high",
    pattern:
      />>?\s*~\/\.(?:ssh\/|aws\/|gnupg\/|kube\/|docker\/config\.json|config\/sergio-keys\/|netrc\b|gitconfig\b)/,
    description: "redirect into credential file",
    decision: "confirm",
    category: "cred-file",
  },
];

const HIGH_NETWORK_EXFIL: Rule[] = [
  {
    id: "high-network-curl-write-method",
    severity: "high",
    pattern: /\bcurl\b[^;|&\n]*-X\s+(?:POST|PUT|PATCH|DELETE)\b/,
    description: "curl -X POST/PUT/PATCH/DELETE — outbound write",
    decision: "confirm",
    category: "network-exfil",
  },
  {
    id: "high-network-wget-method",
    severity: "high",
    pattern: /\bwget\b[^;|&\n]*--method=/,
    description: "wget --method= — outbound write",
    decision: "confirm",
    category: "network-exfil",
  },
  {
    id: "high-network-pipe-to-nc",
    severity: "high",
    pattern: /\|\s*nc\s/,
    description: "anything piped to nc — exfil shape",
    decision: "confirm",
    category: "network-exfil",
  },
];

// --------------------------------------------------------------------------
// MEDIUM — operationally disruptive but reversible
// --------------------------------------------------------------------------

const MEDIUM_SERVICE_CONTROL: Rule[] = [
  {
    id: "medium-service-systemctl",
    severity: "medium",
    // systemctl stop/disable/mask EXCEPT pi-comms
    pattern: /\bsystemctl\s+(?:stop|disable|mask)\s+(?!pi-comms\b)\S/,
    description: "systemctl stop/disable/mask (non-pi-comms service)",
    decision: "confirm",
    category: "service-control",
  },
  {
    id: "medium-service-launchctl",
    severity: "medium",
    pattern: /\blaunchctl\s+(?:unload|remove)\b/,
    description: "launchctl unload/remove",
    decision: "confirm",
    category: "service-control",
  },
  {
    id: "medium-service-sc-stop",
    severity: "medium",
    pattern: /\bsc\s+stop\b/i,
    description: "sc stop (Windows service stop)",
    decision: "confirm",
    category: "service-control",
  },
  {
    id: "medium-service-stop-service",
    severity: "medium",
    pattern: /\bStop-Service\b/i,
    description: "Stop-Service (PowerShell)",
    decision: "confirm",
    category: "service-control",
  },
  {
    id: "medium-service-nssm-stop",
    severity: "medium",
    pattern: /\bnssm\s+stop\b/i,
    description: "nssm stop",
    decision: "confirm",
    category: "service-control",
  },
];

const MEDIUM_KILL_INIT: Rule[] = [
  {
    id: "medium-kill-init-pid1",
    severity: "medium",
    pattern: /\bkill\s+-9\s+1\b/,
    description: "kill -9 1 (kill init)",
    decision: "confirm",
    category: "kill-init",
  },
  {
    id: "medium-kill-init-pkill",
    severity: "medium",
    pattern: /\bpkill\s+-9\s+(?:systemd|init|launchd|services)\b/,
    description: "pkill -9 systemd/init/launchd/services",
    decision: "confirm",
    category: "kill-init",
  },
];

const MEDIUM_FIREWALL: Rule[] = [
  {
    id: "medium-firewall-iptables-flush",
    severity: "medium",
    pattern: /\biptables\s+(?:.*\s)?-F\b/,
    description: "iptables -F (flush rules)",
    decision: "confirm",
    category: "firewall",
  },
  {
    id: "medium-firewall-ufw",
    severity: "medium",
    pattern: /\bufw\s+(?:disable|reset)\b/,
    description: "ufw disable/reset",
    decision: "confirm",
    category: "firewall",
  },
  {
    id: "medium-firewall-netsh",
    severity: "medium",
    pattern: /\bnetsh\s+advfirewall\b/i,
    description: "netsh advfirewall",
    decision: "confirm",
    category: "firewall",
  },
  {
    id: "medium-firewall-ifconfig-down",
    severity: "medium",
    pattern: /\bifconfig\s+\S+\s+down\b/,
    description: "ifconfig <iface> down",
    decision: "confirm",
    category: "firewall",
  },
];

const MEDIUM_PACKAGE_REMOVAL: Rule[] = [
  {
    id: "medium-pkg-npm-uninstall-g",
    severity: "medium",
    pattern: /\bnpm\s+uninstall\s+-g\b/,
    description: "npm uninstall -g",
    decision: "confirm",
    category: "package-removal",
  },
  {
    id: "medium-pkg-pip-uninstall-mass",
    severity: "medium",
    pattern: /\bpip\s+uninstall\s+(?:.*\s)?(?:--all\b|\*)/,
    description: "pip uninstall --all / *",
    decision: "confirm",
    category: "package-removal",
  },
  {
    id: "medium-pkg-apt-purge",
    severity: "medium",
    pattern: /\bapt(?:-get)?\s+(?:purge|autoremove)\b/,
    description: "apt purge / apt autoremove",
    decision: "confirm",
    category: "package-removal",
  },
  {
    id: "medium-pkg-brew-uninstall-force",
    severity: "medium",
    pattern: /\bbrew\s+uninstall\s+(?:.*\s)?--force\b/,
    description: "brew uninstall --force",
    decision: "confirm",
    category: "package-removal",
  },
  {
    id: "medium-pkg-pacman-rns",
    severity: "medium",
    pattern: /\bpacman\s+-Rns\b/,
    description: "pacman -Rns",
    decision: "confirm",
    category: "package-removal",
  },
];

// --------------------------------------------------------------------------
// LOW — log-only / warn-only
// --------------------------------------------------------------------------

const LOW_WORKSPACE_RM: Rule[] = [
  {
    id: "low-workspace-rm-rf-relative",
    severity: "low",
    // rm -rf ./build  /  rm -rf foo/  — WORKSPACE-shaped relative deletes
    pattern: /\brm\s+-[rRf]+\s+(?!\$|~|\/)\.?\/?[A-Za-z0-9._-]+\/?\s*$/,
    description: "rm -rf <relative-workspace-path> — warn-only",
    decision: "allow",
    category: "workspace-rm",
  },
];

// --------------------------------------------------------------------------

export const RULES: readonly Rule[] = Object.freeze([
  ...CRITICAL_FS_WIPE,
  ...CRITICAL_OS_PARTITION,
  ...CRITICAL_PRIV_ESC,
  ...CRITICAL_BOOTLOADER,
  ...CRITICAL_WINDOWS_DESTRUCT,
  ...CRITICAL_INTERPRETER,
  ...CRITICAL_SHELL_LIKE_TOOL,
  ...CRITICAL_PATH_RELATIVE,
  ...CRITICAL_UNICODE_TRICK,
  ...HIGH_GIT_REWRITE,
  ...HIGH_DB_WIPE,
  ...HIGH_RECURSIVE_PERMS,
  ...HIGH_CLOUD_DELETE,
  ...HIGH_CRED_FILE,
  ...HIGH_NETWORK_EXFIL,
  ...MEDIUM_SERVICE_CONTROL,
  ...MEDIUM_KILL_INIT,
  ...MEDIUM_FIREWALL,
  ...MEDIUM_PACKAGE_REMOVAL,
  ...LOW_WORKSPACE_RM,
]);

/**
 * Strictness ordering. Higher = more strict; classifier picks the strictest
 * matching rule across regex + AST passes.
 */
export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const DECISION_ORDER: Record<Decision, number> = {
  allow: 0,
  confirm: 1,
  block: 2,
};
