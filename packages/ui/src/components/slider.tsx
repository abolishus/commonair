// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@commonair/ui/lib/utils";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  getAriaLabel,
  getAriaValueText,
  ...props
}: SliderPrimitive.Root.Props & Pick<SliderPrimitive.Thumb.Props, "getAriaLabel" | "getAriaValueText">) {
  const _values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max];

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-horizontal:min-h-6 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:min-w-6 data-vertical:flex-col pointer-coarse:data-horizontal:min-h-11 pointer-coarse:data-vertical:min-w-11">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-none bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            // The thumb is the focusable range input, so it carries the accessible name.
            getAriaLabel={getAriaLabel}
            getAriaValueText={getAriaValueText}
            className="relative block size-3 shrink-0 rounded-none border border-ring bg-white ring-ring transition-[color,box-shadow] select-none after:absolute after:-inset-2 pointer-coarse:after:-inset-4 hover:ring-1 has-focus-visible:ring-2 has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background active:ring-1 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
