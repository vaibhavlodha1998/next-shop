import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get("user");
  const rows = await query(`SELECT * FROM orders WHERE user_id = '${userId}'`);
  return NextResponse.json(rows);
}

async function query(sql: string): Promise<unknown[]> {
  return [sql];
}
