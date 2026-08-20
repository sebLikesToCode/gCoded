# gCoded

im amkaing an all in one image to gcode website.

# may 27, 20206
just realized i should be documenting this and using version control i will from now on. summary of what i did: i added a crosshatch image fill and an crosshatch shader, in the process of adding the outliner which is quite diffcult.

# august 19, 2026
started using git properly and did a big cleanup pass. the fills and outliner
were producing bad gcode for reasons that were not visible from the ui:

- line spacing was in source-image pixels, not mm, so the same setting meant
  something different for every image. everything is millimetres now, and the
  output is independent of input resolution.
- one G1 per source pixel. straight runs are collapsed with RDP now, so a
  2000px image went from 591k lines / 10MB to about 400 lines.
- no feedrate was ever emitted, so grbl rejected the first G1 with error:22.
  there is a proper preamble and an M2 program end now.
- strokes were emitted in raw scan order and never reversed, so travel was
  over 100% of drawing distance. nearest-neighbour plus 2-opt got it under 10%.
- the outliner filled in solid areas: it marked transition pixels into a grid
  and chained them 8-connected, and any edge thicker than one pixel got snaked
  through. replaced with marching squares on the greyscale map.

also added paper size presets and margins, a blur pass before thresholding,
pen width in the preview so over-dense fills read as solid before plotting,
and pan/zoom/click-to-delete on the preview canvas.
