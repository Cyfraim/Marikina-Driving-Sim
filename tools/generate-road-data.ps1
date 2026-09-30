# =============================================================================
# generate-road-data.ps1
# Builds src/world/roadData.js from an Overpass API JSON dump of Nangka, Marikina.
#
# Source data: (c) OpenStreetMap contributors, ODbL licence (via Overpass API).
# The output file hardcodes the real road network as GPS polylines, which
# src/utils/geo.js converts into Three.js scene units (1 unit = 1 metre).
#
# Usage:
#   powershell -File tools/generate-road-data.ps1 -JsonPath <overpass.json>
# =============================================================================
param(
  [string]$JsonPath = "$env:TEMP\nangka_roads.json",
  [string]$OutPath  = (Join-Path $PSScriptRoot '..\src\world\roadData.js'),
  [double]$RadiusM  = 600,    # keep roads within this radius of the map centre
  [double]$SpacingM = 8,      # min distance between simplified vertices (metres)
  [double]$MinLenM  = 10      # discard chains shorter than this (metres)
)

$ErrorActionPreference = 'Stop'

# Map centre = Nangka, Marikina (see .clinerules)
$CenterLat = 14.6508
$CenterLon = 121.1080
$MPD_LAT = 111132.0                                     # metres per degree latitude
$MPD_LON = 111320.0 * [math]::Cos($CenterLat * [math]::PI / 180.0)  # ~107,690 m/deg lon

$allowed = @('motorway','trunk','primary','secondary','tertiary',
             'residential','unclassified','living_street','service')

# OSM JSON sometimes arrives latin-1 decoded (2-byte UTF-8 chars split apart).
# ASCII strings round-trip unchanged, so we only swap in the result if it differs.
function Fix-Mojibake([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return $s }
  try {
    $fixed = [System.Text.Encoding]::UTF8.GetString(
               [System.Text.Encoding]::GetEncoding(28591).GetBytes($s))
    if ($fixed -ne $s) { return $fixed }
  } catch { }
  return $s
}

if (-not (Test-Path $JsonPath)) { throw "Overpass JSON not found: $JsonPath" }
$json = Get-Content $JsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "Read $($json.elements.Count) ways from $JsonPath"

# --- 1. filter: drivable class + within radius of centre --------------------
$kept = @()
foreach ($e in $json.elements) {
  if ($e.tags.highway -notin $allowed) { continue }
  if (-not $e.geometry) { continue }
  $minD = [double]::MaxValue
  foreach ($g in $e.geometry) {
    $east = ($g.lon - $CenterLon) * $MPD_LON
    $north = ($g.lat - $CenterLat) * $MPD_LAT
    $d = [math]::Sqrt($east*$east + $north*$north)
    if ($d -lt $minD) { $minD = $d }
  }
  if ($minD -gt $RadiusM) { continue }
  $pts = @(); foreach ($g in $e.geometry) { $pts += ,@([double]$g.lat, [double]$g.lon) }
  $kept += [pscustomobject]@{
    Name = (Fix-Mojibake $e.tags.name)
    Tags = $e.tags
    Pts  = $pts
  }
}
Write-Host "Kept $($kept.Count) ways within ${RadiusM} m"

# --- 2. chain segments that share endpoints (one polyline per named road) ----
function Get-Length($pts) {
  $len = 0.0
  for ($i = 1; $i -lt $pts.Count; $i++) {
    $east = ($pts[$i][1] - $pts[$i-1][1]) * $MPD_LON
    $north = ($pts[$i][0] - $pts[$i-1][0]) * $MPD_LAT
    $len += [math]::Sqrt($east*$east + $north*$north)
  }
  return $len
}

$groups = $kept | Group-Object { if ($_.Name) { $_.Name } else { "#unnamed-$($_.Pts[0][0])-$($_.Pts[0][1])" } }
$chains = @()
$tol = 1e-6   # degrees (~0.1 m) - OSM shared nodes are normally exact

function New-PointList($pts) {
  $list = New-Object System.Collections.ArrayList
  foreach ($pt in $pts) { [void]$list.Add($pt) }
  return $list
}
function Join-Points($a, $b) {
  # returns ArrayList: all points of $a followed by all points of $b
  $out = New-Object System.Collections.ArrayList
  foreach ($pt in $a) { [void]$out.Add($pt) }
  foreach ($pt in $b) { [void]$out.Add($pt) }
  return $out
}
function Get-ReversedPts($pts) {
  $out = New-Object System.Collections.ArrayList
  for ($i = $pts.Count - 1; $i -ge 0; $i--) { [void]$out.Add($pts[$i]) }
  return $out
}
function Test-SamePoint($a, $b) {
  return ([math]::Abs($a[0]-$b[0]) -lt $tol -and [math]::Abs($a[1]-$b[1]) -lt $tol)
}

foreach ($grp in $groups) {
  $pool = New-Object System.Collections.ArrayList
  foreach ($m in $grp.Group) {
    if ($m.Pts.Count -lt 2) { continue }
    # W = length of this segment; tags of the LONGEST segment win for the chain
    [void]$pool.Add(@{ Pts = (New-PointList $m.Pts); Tags = $m.Tags; Name = $m.Name;
                       W = (Get-Length $m.Pts) })
  }

  while ($pool.Count -gt 0) {
    $chain = $pool[0]; [void]$pool.RemoveAt(0)
    $changed = $true
    while ($changed) {
      $changed = $false
      for ($i = 0; $i -lt $pool.Count; $i++) {
        $c = $chain.Pts; $p = $pool[$i].Pts
        $c0 = $c[0]; $c1 = $c[$c.Count-1]
        $p0 = $p[0]; $p1 = $p[$p.Count-1]
        $newPts = $null
        if      (Test-SamePoint $c1 $p0) { $newPts = Join-Points $c $p }             # ...c + p...
        elseif (Test-SamePoint $c1 $p1) { $newPts = Join-Points $c (Get-ReversedPts $p) }
        elseif (Test-SamePoint $c0 $p1) { $newPts = Join-Points $p $c }              # ...p + c...
        elseif (Test-SamePoint $c0 $p0) { $newPts = Join-Points (Get-ReversedPts $p) $c }
        if ($newPts) {
          $next = $pool[$i]
          $tags = if ($next.W -gt $chain.W) { $next.Tags } else { $chain.Tags }
          $wmax = [math]::Max($chain.W, $next.W)
          $chain = @{ Pts = $newPts; Tags = $tags; Name = $chain.Name; W = $wmax }
          [void]$pool.RemoveAt($i)
          $changed = $true
          break
        }
      }
    }
    $chains += ,$chain
  }
}
Write-Host "Chained into $($chains.Count) polylines"

# --- 3. measure length, drop stubs, simplify vertices ------------------------
# Decimate: keep a vertex only if it is $SpacingM from the last kept one
function Simplify($pts, [double]$spacing) {
  if ($pts.Count -le 2) { return ,$pts }
  $out = New-Object System.Collections.ArrayList
  [void]$out.Add($pts[0])
  $acc = 0.0
  for ($i = 1; $i -lt $pts.Count - 1; $i++) {
    $east = ($pts[$i][1] - $pts[$i-1][1]) * $MPD_LON
    $north = ($pts[$i][0] - $pts[$i-1][0]) * $MPD_LAT
    $acc += [math]::Sqrt($east*$east + $north*$north)
    if ($acc -ge $spacing) { [void]$out.Add($pts[$i]); $acc = 0.0 }
  }
  [void]$out.Add($pts[$pts.Count-1])
  return ,$out.ToArray()
}

# --- 4. derive width / sidewalk / markings from real OSM tags ---------------
# Width rules (in order of trust):
#   1. explicit OSM `width` tag (metres)
#   2. OSM `lanes` tag: arterial roads use 3.5 m/lane, small streets 2.75 m/lane
#      (a 2-lane barangay street is ~5-6 m, NOT 7 m)
#   3. per-class default tuned to real Nangka:
#      primary 9 (J.P. Rizal is tagged width=9), secondary 14 (Bayan-Bayanan,
#      4 lanes), tertiary 7, residential 5.5, service 3.5
function Get-Width($tags, $cls) {
  if ($tags.width) {
    $w = 0.0
    if ([double]::TryParse($tags.width, [ref]$w) -and $w -gt 0) { return $w }
  }
  if ($tags.lanes) {
    $ln = 0.0
    if ([double]::TryParse($tags.lanes, [ref]$ln) -and $ln -gt 0) {
      # main roads are wide (3.5 m/lane), small streets are narrow
      $per = if ($cls -in @('primary','secondary','tertiary')) { 3.5 } else { 2.75 }
      return $per * $ln
    }
  }
  switch ($cls) {
    'primary'      { return 9.0 }    # Marikina-San Mateo Rd
    'secondary'    { return 14.0 }   # Bayan-Bayanan Ave, 4 lanes
    'tertiary'     { return 7.0 }
    'residential'  { return 5.5 }    # 1 lane each way
    'unclassified' { return 5.5 }
    'living_street'{ return 5.0 }
    'service'      { return 3.5 }    # alleys / service roads
    default        { return 5.5 }
  }
}

# Surface: real OSM `surface` tag, else default by class.
# Nangka reality per OSM: main/tertiary roads are ASPHALT, barangay
# (residential) streets are mostly CONCRETE. Concrete is light grey.
function Get-Surface($tags, $cls) {
  $s = "$($tags.surface)"
  switch ($s) {
    'concrete'      { return 'concrete' }
    'asphalt'       { return 'asphalt' }
    'paved'         { return 'concrete' }  # paved ~ concrete slab in PH
    'unpaved'       { return 'unpaved' }
    'ground'        { return 'unpaved' }
    default {
      if ($cls -in @('primary','secondary','tertiary')) { return 'asphalt' }
      return 'concrete'
    }
  }
}
function Get-Sidewalk($tags, $cls) {
  switch ("$($tags.sidewalk)") {
    'both'  { return 'both' }
    'left'  { return 'left' }
    'right' { return 'right' }
    default {
      # Main roads in Nangka have sidewalks on both sides even when untagged
      if ($cls -in @('primary','secondary','tertiary')) { return 'both' }
      return 'none'
    }
  }
}
function Get-Markings($tags, $cls) {
  if ("$($tags.lane_markings)" -eq 'no')  { return $false }
  if ("$($tags.lane_markings)" -eq 'yes') { return $true }
  return ($cls -in @('primary','secondary','tertiary'))
}

# --- 5. emit the JS data module ---------------------------------------------
$roads = @()
$totalLen = 0.0
foreach ($ch in $chains) {
  $len = Get-Length $ch.Pts
  if ($len -lt $MinLenM) { continue }
  $pts = Simplify $ch.Pts $SpacingM
  $cls = "$($ch.Tags.highway)"
  $sw  = Get-Sidewalk $ch.Tags $cls
  $mk  = Get-Markings $ch.Tags $cls
  $w   = Get-Width $ch.Tags $cls
  $sf  = Get-Surface $ch.Tags $cls
  # tunay na pangalan ng kalsada para sa minimap/watermark
  $nm  = $ch.Name
  $totalLen += $len
  $ptStr = ($pts | ForEach-Object { "[$($_[0].ToString('0.00000')),$($_[1].ToString('0.00000'))]" }) -join ','
  $roads += "  { name: $(if ($nm) { "'$(($nm -replace "'","\\'"))'" } else { 'null' }), cls: '$cls', w: $w, sw: '$sw', mk: $($mk.ToString().ToLower()), surf: '$sf', pts: [$ptStr] },"
}
Write-Host ("Roads emitted: {0}   total centreline length: {1:N0} m" -f $roads.Count, $totalLen)

$header = @'
// ---------------------------------------------------------------------------
// roadData.js - HARDKODED na road network ng Nangka, Marikina City
// Generated by tools/generate-road-data.ps1 from OpenStreetMap data
// (c) OpenStreetMap contributors, ODbL - https://www.openstreetmap.org/copyright
//
// Every polyline is real GPS data. pts = [latitude, longitude] pairs.
// src/utils/geo.js converts these to Three.js scene units (1 unit = 1 metre)
// relative to MAP_ORIGIN below (barangay centre, see .clinerules).
//
// w     = road width (metres, from OSM width/lanes tags)
// sw    = sidewalk side ('both'|'left'|'right'|'none')
// mk    = centre lane markings (dashed)
// surf  = surface from OSM 'surface' tag: 'concrete' | 'asphalt' | 'unpaved'
//         (concrete = light grey, asphalt = dark grey)
// pts   = [latitude, longitude]
// ---------------------------------------------------------------------------
'@

$body = @("export const MAP_ORIGIN = { lat: 14.6508, lon: 121.1080 };", "", "export const ROADS = [")
$body += $roads
$body += "];"

$OutDir = Split-Path $OutPath -Parent
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
(@($header) + @("") + $body) -join "`n" | Set-Content $OutPath -Encoding UTF8
Write-Host "Wrote $OutPath"

