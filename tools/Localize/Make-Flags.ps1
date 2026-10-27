$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$outDir=Join-Path $PSScriptRoot '../../assets/flags'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
foreach($language in @('ko','ja','en')) {
 $bmp=[Drawing.Bitmap]::new(384,256)
 $g=[Drawing.Graphics]::FromImage($bmp)
 $g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
 $g.Clear([Drawing.Color]::White)
 if($language -eq 'ja') { $g.FillEllipse([Drawing.Brushes]::Crimson,115.2,51.2,153.6,153.6) }
 if($language -eq 'en') {
  $stripe=256.0/13
  for($row=0;$row -lt 13;$row+=2) { $g.FillRectangle([Drawing.Brushes]::Firebrick,0,($row*$stripe),384,$stripe) }
  $g.FillRectangle([Drawing.Brushes]::MidnightBlue,0,0,154,($stripe*7))
  for($row=0;$row -lt 9;$row++) {
   $count=if($row%2 -eq 0){6}else{5}
   for($col=0;$col -lt $count;$col++) {
    $cx=if($count -eq 6){12.8+$col*25.6}else{25.6+$col*25.6}
    $cy=7.65+$row*15.3
    $points=[Drawing.PointF[]]@(for($j=0;$j -lt 10;$j++) {
     $r=if($j%2 -eq 0){6.0}else{2.4}; $a=-[Math]::PI/2+$j*[Math]::PI/5
     [Drawing.PointF]::new(($cx+$r*[Math]::Cos($a)),($cy+$r*[Math]::Sin($a)))
    })
    $g.FillPolygon([Drawing.Brushes]::White,$points)
   }
  }
 }
 if($language -eq 'ko') {
  $saved=$g.Save(); $g.TranslateTransform(192,128); $g.RotateTransform(33.69)
  $g.FillEllipse([Drawing.Brushes]::RoyalBlue,-64,-64,128,128)
  $g.FillPie([Drawing.Brushes]::Crimson,-64,-64,128,128,180,180)
  $g.FillEllipse([Drawing.Brushes]::Crimson,-64,-32,64,64)
  $g.FillEllipse([Drawing.Brushes]::RoyalBlue,0,-32,64,64)
  $g.Restore($saved)
  # Top-left heaven, bottom-right earth; top-right water, bottom-left fire.
  $trigrams=@(@(-108,-72,-56.31,0,0,0),@(108,72,-56.31,1,1,1),@(108,-72,56.31,1,0,1),@(-108,72,56.31,0,1,0))
  foreach($t in $trigrams) {
   $saved=$g.Save(); $g.TranslateTransform((192+$t[0]),(128+$t[1])); $g.RotateTransform($t[2])
   for($j=0;$j -lt 3;$j++) {
    $y=-24+$j*17
    if($t[$j+3] -eq 0){$g.FillRectangle([Drawing.Brushes]::Black,-32,$y,64,10)}
    else{$g.FillRectangle([Drawing.Brushes]::Black,-32,$y,28,10);$g.FillRectangle([Drawing.Brushes]::Black,4,$y,28,10)}
   }
   $g.Restore($saved)
  }
 }
 $bmp.Save((Join-Path $outDir "$language.png"),[Drawing.Imaging.ImageFormat]::Png)
 $g.Dispose();$bmp.Dispose()
}
