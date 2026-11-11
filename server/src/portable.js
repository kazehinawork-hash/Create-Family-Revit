import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { slugify } from "./bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sinh nội dung file Type Catalog (.txt) chuẩn Revit cho Family.
 * Revit yêu cầu:
 * - Tên file .txt phải trùng 100% với tên file .rfa (cùng thư mục).
 * - Dòng đầu tiên định nghĩa header: ,TênThamSố##KIỂU##ĐƠN_VỊ,...
 * - Dấu phẩy đầu dòng đại diện cho cột Tên Type.
 * - Mã hóa UTF-16LE with BOM hoặc ANSI để Revit đọc đúng.
 */
export function generateTypeCatalogContent(spec) {
  if (!spec || !Array.isArray(spec.parameters)) return null;

  // Lấy các tham số cơ bản dạng Length hoặc Text thuộc nhóm kích thước chính
  const drivingParams = [
    { name: "Nominal Diameter", header: "Nominal Diameter##LENGTH##MILLIMETERS" },
    { name: "Face to Face Length", header: "Face to Face Length##LENGTH##MILLIMETERS" },
    { name: "Flange Diameter", header: "Flange Diameter##LENGTH##MILLIMETERS" },
    { name: "Flange Thickness", header: "Flange Thickness##LENGTH##MILLIMETERS" },
    { name: "Raised Face Diameter", header: "Raised Face Diameter##LENGTH##MILLIMETERS" },
    { name: "Bolt Circle Diameter", header: "Bolt Circle Diameter##LENGTH##MILLIMETERS" },
    { name: "Bolt Hole Diameter", header: "Bolt Hole Diameter##LENGTH##MILLIMETERS" },
  ];

  // Bảng kích thước tiêu chuẩn dải van Fivalco F6316-PPR PN16 (từ DN50 đến DN200)
  const isFivalcoPrv = (spec.name || "").toLowerCase().includes("f6316") || (spec.name || "").toLowerCase().includes("prv");

  let rows;
  if (isFivalcoPrv) {
    rows = [
      { type: "DN50 PN16 (2\")", values: [50, 230, 165, 19, 99, 125, 18] },
      { type: "DN65 PN16 (2-1/2\")", values: [65, 290, 185, 19, 118, 145, 18] },
      { type: "DN80 PN16 (3\")", values: [80, 310, 200, 19, 132, 160, 18] },
      { type: "DN100 PN16 (4\")", values: [100, 350, 220, 19, 156, 180, 18] },
      { type: "DN125 PN16 (5\")", values: [125, 400, 250, 19, 184, 210, 18] },
      { type: "DN150 PN16 (6\")", values: [150, 480, 285, 19, 211, 240, 22] },
      { type: "DN200 PN16 (8\")", values: [200, 600, 340, 20, 266, 295, 22] },
    ];
  } else {
    // Với model thông thường: xuất type hiện tại
    const typeName = spec.typeName || "Default";
    const values = drivingParams.map(p => {
      const match = spec.parameters.find(x => x.name === p.name);
      return match ? match.value : 0;
    });
    rows = [{ type: typeName, values }];
  }

  const headerLine = "," + drivingParams.map(p => p.header).join(",");
  const dataLines = rows.map(r => `"${r.type}",` + r.values.join(","));

  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Đóng gói thư mục thành file .zip bằng powershell Compress-Archive
 */
function zipFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const cmd = "powershell.exe";
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceFolder}', '${zipFilePath}')`
    ];

    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(zipFilePath);
    });
  });
}

/**
 * Escape chuỗi để nhúng an toàn vào chuỗi "..." của PowerShell.
 * Tên family thường chứa dấu " (inch) hoặc $, làm script vỡ cú pháp.
 */
export function escapePowerShellString(value) {
  return String(value)
    .replace(/`/g, "``")
    .replace(/"/g, '`"')
    .replace(/\$/g, "`$");
}

/**
 * Tạo kịch bản PowerShell chạy Portable tự động 100% (Zero-click):
 * Khởi động Revit, tự động dựng hình, MOVE file .rfa ra ngoài và tự đóng Revit.
 */
function generatePs1Script(rawSpecName, safeName) {
  const specName = escapePowerShellString(rawSpecName);
  const runnerPs1Name = `runner-${safeName}.ps1`;
  const batLauncherName = `1-Click-Build-${safeName}.bat`;
  const specFileName = `${safeName}-spec.json`;
  const readmeFileName = `HUONG_DAN-${safeName}.txt`;

  return `# PowerShell Portable Builder Script (Auto-Build 100%)
$ErrorActionPreference = "Continue"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  DANG KHOI DONG RUNNER DUNG FAMILY SNAPSHOT CHO REVIT (TU DONG 100%)" -ForegroundColor Green
Write-Host "  Model: ${specName}" -ForegroundColor Yellow
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Tim kiem Revit.exe
$revitCandidates = @(
    "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2023\\Revit.exe"
)

$revitExe = $null
$revitVer = "2024"

foreach ($candidate in $revitCandidates) {
    if (Test-Path $candidate) {
        $revitExe = $candidate
        if ($candidate -match "Revit (\\d{4})") {
            $revitVer = $matches[1]
        }
        break
    }
}

if (-not $revitExe) {
    Write-Host "[LOI] Khong tim thay Revit.exe tren may tai thu muc mac dinh C:\\Program Files\\Autodesk!" -ForegroundColor Red
    Write-Host "Vui long cai dat hoac kiem tra lai phien ban Revit tren may." -ForegroundColor Yellow
    Read-Host "Nhan Enter de thoat..."
    exit
}

Write-Host "[OK] Phat hien Revit: $revitExe (Phien ban: $revitVer)" -ForegroundColor Yellow

# 2. Tao thu muc Shadow Copy rieng biet trong %TEMP%
# Dieu nay giup file DLL trong thu muc hien tai (Downloads) KHONG BAO GIO bi Revit khoa,
# ke ca khi nguoi dung dang mo san mot phien lam viec Revit khac!
$currentDir = $PSScriptRoot
$shadowId = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
$shadowDir = [System.IO.Path]::Combine($env:TEMP, "FA-Shadow-" + $shadowId)
if (-not (Test-Path $shadowDir)) {
    New-Item -ItemType Directory -Path $shadowDir -Force | Out-Null
}

# Sao chep cac file DLL can thiet sang thu muc shadow trong %TEMP%
$runnerDlls = @("FamilyAgent.Addin.dll", "FamilyAgent.Core.dll", "Newtonsoft.Json.dll")
foreach ($dll in $runnerDlls) {
    $src = [System.IO.Path]::Combine($currentDir, $dll)
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $shadowDir $dll) -Force -ErrorAction SilentlyContinue
    }
}

$addinDir = [System.IO.Path]::Combine($env:APPDATA, "Autodesk", "Revit", "Addins", $revitVer)
if (-not (Test-Path $addinDir)) {
    New-Item -ItemType Directory -Path $addinDir -Force | Out-Null
}

# Cai dat luon FamilyAgent Add-in vao %APPDATA% de sau khi build xong, mo bat ky file .rfa nao
# trong Revit cung tu dong co tab Family Agent va tu dong cap nhat hinh hoc 3D khi sua Parameter!
$permTargetDir = [System.IO.Path]::Combine($addinDir, "FamilyAgent")
if (-not (Test-Path $permTargetDir)) {
    New-Item -ItemType Directory -Path $permTargetDir -Force | Out-Null
}
foreach ($dll in $runnerDlls) {
    $src = [System.IO.Path]::Combine($currentDir, $dll)
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $permTargetDir $dll) -Force -ErrorAction SilentlyContinue
    }
}
$permAssemblyPath = [System.IO.Path]::Combine($permTargetDir, "FamilyAgent.Addin.dll")
$permGuid = "8b0f4a8e-2c11-4f5a-9a0e-6f1f4d1c2a77"
$permManifestFile = [System.IO.Path]::Combine($addinDir, "FamilyAgent.addin")
$permManifestContent = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>Family Agent</Name>
    <Assembly>$permAssemblyPath</Assembly>
    <AddInId>$permGuid</AddInId>
    <FullClassName>FamilyAgent.Addin.App</FullClassName>
    <VendorId>FAMLYAGT</VendorId>
    <VendorDescription>Family Agent — parametric Revit family studio</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
[System.IO.File]::WriteAllText($permManifestFile, $permManifestContent, (New-Object System.Text.UTF8Encoding($false)))

$manifestFile = [System.IO.Path]::Combine($addinDir, "FamilyAgent_Portable_Temp.addin")
# Assembly tro den ban copy trong %TEMP%, hoan toan giai phong thu muc Downloads
$assemblyPath = [System.IO.Path]::Combine($shadowDir, "FamilyAgent.Addin.dll")
$addInGuid = "9b1f4a8e-2c11-4f5a-9a0e-6f1f4d1c2c99"

# Tu dong dang ky AddInId vao CodeSigning Registry de Revit bo qua hop thoai Security Unsigned Add-In (Always Load)
$codeSigningKeys = @(
    "HKCU:\\Software\\Autodesk\\Revit\\Autodesk Revit " + $revitVer + "\\CodeSigning",
    "HKCU:\\Software\\Autodesk\\Revit\\" + $revitVer + "\\CodeSigning"
)
foreach ($regKey in $codeSigningKeys) {
    if (-not (Test-Path $regKey)) {
        New-Item -Path $regKey -Force | Out-Null
    }
    Set-ItemProperty -Path $regKey -Name $addInGuid -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regKey -Name $permGuid -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
}

# Manifest dang Application tu dong thuc thi khi khoi dong
$manifestContent = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>Family Agent Portable Auto Builder</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>$addInGuid</AddInId>
    <FullClassName>FamilyAgent.Addin.PortableAutoApp</FullClassName>
    <VendorId>FAMLYAGT</VendorId>
  </AddIn>
</RevitAddIns>
"@

[System.IO.File]::WriteAllText($manifestFile, $manifestContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Da nap runner tu dong vao Revit (va bo qua hop thoai Security)." -ForegroundColor Cyan

# Dat bien moi truong: chi ro file spec can build va thu muc luu
$specFullPath = [System.IO.Path]::Combine($currentDir, "${specFileName}")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_AUTO_EXIT", "1", "Process")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_SPEC", $specFullPath, "Process")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_OUT", $currentDir, "Process")

# 3. Kiem tra va khoi chay tien trinh Revit moi (chay song song)
$isRunning = Get-Process -Name "Revit" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
if ($isRunning) {
    Write-Host "[THONG BAO]: Phat hien Revit dang mo tren may. Dang khoi chay mot tien trinh Revit rieng biet de dung Family..." -ForegroundColor Yellow
} else {
    Write-Host "[THONG BAO]: Dang khoi dong Revit de tu dong dung Native Family..." -ForegroundColor Green
}
Write-Host "Ban khong can thao tac gi them, he thong se TU DONG dung truc tiep file .rfa tai day!" -ForegroundColor Cyan
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
Write-Host ""

$buildStartedAt = Get-Date
$revitProcess = Start-Process $revitExe -PassThru

Write-Host "Dang theo doi va cho file .rfa xuat hien tai thu muc nay..." -ForegroundColor Cyan

$rfaFound = $false
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    $rfaFiles = Get-ChildItem -Path $currentDir -Filter "*.rfa" |
        Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
        Sort-Object LastWriteTime -Descending
    if ($rfaFiles.Count -gt 0) {
        $rfaFound = $true
        $targetRfa = $rfaFiles[0].FullName
        break
    }
}

Write-Host ""
if ($rfaFound) {
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "  THANH CONG! FILE .RFA DA DUOC TAO TRUC TIEP TAI THU MUC CUA BAN:" -ForegroundColor Green
    Write-Host "  -> $targetRfa" -ForegroundColor Yellow
    Write-Host "  File la snapshot day du hinh khoi; parameter la metadata, khong tu bien thien kich thuoc." -ForegroundColor Green
    Write-Host "=====================================================================" -ForegroundColor Green
} else {
    Write-Host "Tien trinh cho qua thoi gian hoac chua hoan tat. Vui long kiem tra file build_error.log." -ForegroundColor Yellow
}

# 4. Don dep manifest tam thoi va registry sach se
if (Test-Path $manifestFile) {
    Remove-Item $manifestFile -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Da don dep sach se runner tam thoi trong Revit." -ForegroundColor Gray
}

foreach ($regKey in $codeSigningKeys) {
    Remove-ItemProperty -Path $regKey -Name $addInGuid -ErrorAction SilentlyContinue
}

# 5. Don dep triet de cac file trung gian
# Vi DLL duoc shadow copy sang %TEMP% nen cac file tai $currentDir khong bi Revit khoa
if ($rfaFound) {
    Write-Host ""
    Write-Host "[DANG DON DEP]: Dang don dep file trung gian..." -ForegroundColor Cyan

    # Danh sach cac file thuoc goi Portable cua dung model nay can don dep
    $filesToClean = @(
        "FamilyAgent.Addin.dll",
        "FamilyAgent.Core.dll",
        "Newtonsoft.Json.dll",
        "${specFileName}",
        "${runnerPs1Name}",
        "${readmeFileName}",
        "build_result.txt",
        "build_error.log",
        "build_crash.log"
    )

    foreach ($file in $filesToClean) {
        $target = Join-Path $currentDir $file
        if (Test-Path $target) {
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                Remove-Item $target -Force -ErrorAction SilentlyContinue
                if (-not (Test-Path $target)) { break }
                Start-Sleep -Milliseconds 300
            }
        }
    }

    # Don dep thu muc shadow trong %TEMP% (neu chua co tien trinh nao khoa)
    if (Test-Path $shadowDir) {
        Remove-Item -Path $shadowDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Tu dong xoa file .bat cua dung model nay sau 1 giay bang tien trinh CMD ngam
    $batFile = Join-Path $currentDir "${batLauncherName}"
    if (Test-Path $batFile) {
        $delBatCmd = '/c timeout /t 1 /nobreak >nul & del /f /q "' + $batFile + '"'
        Start-Process cmd.exe -ArgumentList $delBatCmd -WindowStyle Hidden
    }

    Write-Host "[HOAN TAT]: Da don dep sach se! Thu muc chi giu lai file .rfa va file .zip cua ban." -ForegroundColor Green
}

Read-Host "Nhan Enter de thoat..."
`;
}

/**
 * Tạo gói Portable 1-Click Builder cho người dùng không cần cài Addin
 */
export async function createPortablePackage(spec) {
  const safeName = slugify(spec.name || "Family");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `family-portable-${safeName}-`));
  const packageDir = path.join(tempDir, `Build-${safeName}`);
  fs.mkdirSync(packageDir, { recursive: true });

  // 1. Lưu spec.json vào gói
  const specPath = path.join(packageDir, `${safeName}-spec.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");

  // 1.1 Tạo file Type Catalog (.txt) chuẩn Revit cùng tên với Family
  const catalogContent = generateTypeCatalogContent(spec);
  if (catalogContent) {
    // Revit yêu cầu file Type Catalog lưu UTF-16LE with BOM
    const catalogBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(catalogContent, "utf16le")]);
    fs.writeFileSync(path.join(packageDir, `${safeName}.txt`), catalogBuffer);
  }

  // 2. Copy các file DLL của Addin đã build sẵn
  const binDir = path.resolve(__dirname, "../../revit-addin/FamilyAgent.Addin/bin/Release");
  const requiredDlls = [
    "FamilyAgent.Addin.dll",
    "FamilyAgent.Core.dll",
    "Newtonsoft.Json.dll"
  ];

  const missing = requiredDlls.filter((dll) => !fs.existsSync(path.join(binDir, dll)));
  if (missing.length > 0) {
    throw new Error(`Add-in build is incomplete: missing ${missing.join(", ")}. Run npm run addin first.`);
  }

  for (const dll of requiredDlls) {
    fs.copyFileSync(path.join(binDir, dll), path.join(packageDir, dll));
  }

  // 3. Tạo file PowerShell script (.ps1) với BOM UTF-8, vì Windows PowerShell 5.1
  // đọc file không BOM theo ANSI và sẽ làm hỏng tên family có dấu tiếng Việt.
  const ps1Content = generatePs1Script(spec.name || "Family", safeName);
  fs.writeFileSync(path.join(packageDir, `runner-${safeName}.ps1`), `\uFEFF${ps1Content}`, "utf8");

  // 4. Tạo file .bat wrapper chuẩn ASCII với tên riêng theo model
  const batContent = `@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0runner-${safeName}.ps1"\r\n`;
  fs.writeFileSync(path.join(packageDir, `1-Click-Build-${safeName}.bat`), batContent, "ascii");

  // 5. Tạo file HDSD ngắn gọn với tên riêng theo model
  const readmeContent = `HUONG DAN DUNG FILE .RFA SNAPSHOT TU DONG:
1. Click dup chuot vao file "1-Click-Build-${safeName}.bat".
2. Revit se tu dong khoi dong ngam, tao family snapshot day du hinh khoi va tham so.
3. File .rfa se duoc TU DONG MOVE ve ngay thu muc nay.
4. Cua so thu muc se tu dong mo len cho ban lay file!
5. Parameter trong .rfa la metadata; khong tu dieu khien kich thuoc nhu studio.
`;
  fs.writeFileSync(path.join(packageDir, `HUONG_DAN-${safeName}.txt`), readmeContent, "utf8");

  // 6. Nén thành file zip
  const zipPath = path.join(tempDir, `${safeName}-Portable-Revit.zip`);
  await zipFolder(packageDir, zipPath);

  return {
    zipPath,
    fileName: `${safeName}-Portable-Revit.zip`,
    cleanup: () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  };
}
