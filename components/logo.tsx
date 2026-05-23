/* eslint-disable @next/next/no-img-element */
import clsx from "clsx";

export function MedVolLogo({
  className,
  size = 32,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <img
      src="/logo.png"
      alt="MedVol"
      width={size}
      height={size}
      className={clsx("object-contain", className)}
      style={{ height: size, width: "auto" }}
    />
  );
}
