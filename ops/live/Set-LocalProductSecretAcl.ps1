param(
    [string]$SecretRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001\secrets"
    )
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Set-LocalProductSecretAcl.ps1 requires Windows"
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $currentIdentity.User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
)
$allowedSidValues = @($currentSid.Value, $systemSid.Value)

function New-DirectoryRule(
    [System.Security.Principal.SecurityIdentifier]$Identity
) {
    return [System.Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        (
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit `
            -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        ),
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
}

function New-FileRule(
    [System.Security.Principal.SecurityIdentifier]$Identity
) {
    return [System.Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
}

function Reset-PathAcl([string]$Path, [bool]$IsDirectory) {
    $acl = if ($IsDirectory) {
        [System.Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [System.Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($currentSid)
    foreach ($identity in @($currentSid, $systemSid)) {
        $rule = if ($IsDirectory) {
            New-DirectoryRule $identity
        }
        else {
            New-FileRule $identity
        }
        [void]$acl.AddAccessRule($rule)
    }
    if ($IsDirectory) {
        [System.IO.DirectoryInfo]::new($Path).SetAccessControl($acl)
    }
    else {
        [System.IO.FileInfo]::new($Path).SetAccessControl($acl)
    }
}

function Assert-PathAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "Secret ACL inheritance remains enabled: $Path"
    }
    $rules = @(
        $acl.GetAccessRules(
            $true,
            $false,
            [System.Security.Principal.SecurityIdentifier]
        )
    )
    if ($rules.Count -ne 2) {
        throw "Secret ACL must contain exactly two explicit rules: $Path"
    }
    foreach ($rule in $rules) {
        if (
            $rule.AccessControlType -ne
                [System.Security.AccessControl.AccessControlType]::Allow `
            -or $rule.FileSystemRights -band
                [System.Security.AccessControl.FileSystemRights]::FullControl `
                -ne [System.Security.AccessControl.FileSystemRights]::FullControl `
            -or $rule.IdentityReference.Value -notin $allowedSidValues
        ) {
            throw "Secret ACL contains an unauthorized rule: $Path"
        }
    }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($SecretRoot)
New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
$items = @(
    Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse
)

Reset-PathAcl $resolvedRoot $true
foreach ($directory in $items | Where-Object PSIsContainer) {
    Reset-PathAcl $directory.FullName $true
}
foreach ($file in $items | Where-Object { -not $_.PSIsContainer }) {
    Reset-PathAcl $file.FullName $false
}

Assert-PathAcl $resolvedRoot
foreach ($item in $items) {
    Assert-PathAcl $item.FullName
}

[pscustomobject]@{
    secretRoot = $resolvedRoot
    ownerSid = $currentSid.Value
    allowedPrincipalCount = 2
    inheritanceDisabled = $true
}
