import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: send signed-out visitors away from /admin early.
// The real authorization happens in the page, route handlers and Server Actions.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("demo_user")) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
