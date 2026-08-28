# Ritar röda markeringar på skärmbilderna till inloggningsguiden.
# Koordinaterna är i bildens egna pixlar (1206x2622).
Add-Type -AssemblyName System.Drawing

$kalla = "C:\Users\tilde\Desktop"
$mal   = "C:\Users\tilde\Desktop\equiworks-guide"
if (-not (Test-Path $mal)) { New-Item -ItemType Directory -Path $mal | Out-Null }

$rod = [System.Drawing.Color]::FromArgb(255, 226, 32, 40)

function Rita {
    param(
        [string]$in, [string]$ut,
        [array]$ringar = @(),      # varje ring: @(x1,y1,x2,y2)
        [array]$kryss  = @(),      # varje kryss: @(x1,y1,x2,y2) — ram + diagonaler
        [array]$dolt   = @()       # varje ruta: @(x1,y1,x2,y2) — vit yta som täcker över
    )
    $img = [System.Drawing.Image]::FromFile((Join-Path $kalla $in))
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)

    $vit = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    foreach ($d in $dolt) {
        $g.FillRectangle($vit, [int]$d[0], [int]$d[1], [int]($d[2] - $d[0]), [int]($d[3] - $d[1]))
    }
    $vit.Dispose()

    $penna = New-Object System.Drawing.Pen($rod, 11)
    foreach ($r in $ringar) {
        $g.DrawEllipse($penna, [int]$r[0], [int]$r[1], [int]($r[2] - $r[0]), [int]($r[3] - $r[1]))
    }
    foreach ($k in $kryss) {
        $g.DrawRectangle($penna, [int]$k[0], [int]$k[1], [int]($k[2] - $k[0]), [int]($k[3] - $k[1]))
        $g.DrawLine($penna, [int]$k[0], [int]$k[1], [int]$k[2], [int]$k[3])
        $g.DrawLine($penna, [int]$k[0], [int]$k[3], [int]$k[2], [int]$k[1])
    }

    $penna.Dispose(); $g.Dispose(); $img.Dispose()
    $bmp.Save((Join-Path $mal $ut), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "$ut klar"
}

# 1. Inbjudningsmejlet — ringa in knappen "Öppna EquiWorks"
Rita -in "1.png" -ut "steg1-oppna-equiworks.png" -ringar @(,@(110, 1620, 730, 1830))

# 2. Inloggningssidan — ringa in dela-knappen uppe till höger
Rita -in "2.png" -ut "steg2-dela-knappen.png" -ringar @(,@(1035, 180, 1175, 320))

# 3. Delningsrutan — täck över kontakterna med vitt, ringa in "Visa mer"
Rita -in "4.png" -ut "steg3-visa-mer.png" `
     -ringar @(,@(880, 1400, 1120, 1750)) `
     -dolt   @(,@(40, 600, 1172, 1010))

# 4. Hela listan — ringa in "Lägg till på hemskärmen"
Rita -in "3.png" -ut "steg4-lagg-till-hemskarmen.png" -ringar @(,@(55, 1985, 1150, 2195))

# 5. Hemskärmen — ringa in EquiWorks-ikonen
Rita -in "6.png" -ut "steg5-ikonen.png" -ringar @(,@(610, 845, 880, 1165))

# 6. Inloggningssidan igen — ringa in mejlfältet
Rita -in "2.png" -ut "steg6-fyll-i-mejl.png" -ringar @(,@(60, 1330, 1145, 1550))

# 7. Kodmejlet — ringa in koden
Rita -in "7.png" -ut "steg7-koden-i-mejlet.png" -ringar @(,@(110, 1185, 870, 1365))

# 8. Kodsidan — ringa in fältet där koden skrivs in
Rita -in "5.png" -ut "steg8-skriv-in-koden.png" -ringar @(,@(60, 760, 1145, 970))

# 9. Klart — ingen markering
Copy-Item (Join-Path $kalla "8.png") (Join-Path $mal "steg9-inloggad.png") -Force
"steg9-inloggad.png klar"
