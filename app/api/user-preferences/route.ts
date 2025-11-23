import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient()

        const {data: {user}, error: authError} = await supabase.auth.getUser();

        if (authError) {
            console.error("Auth error:", authError);
            return NextResponse.json(
                {error: "Authentication failed"},
                {status: 401}
            );
        }

        if (!user) {
            return NextResponse.json(
                {error: "You must be logged in to save preferences"},
                {status: 401}
            );
        }

        const body = await request.json();
        const {categories, frequency, email} = body;

        console.log("Received preferences:", { categories, frequency, email });

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
        return NextResponse.json(
            {error: "Categories array is required and must not be empty"}, 
            {status: 400}
        )
    }

    if (!frequency || !["daily", "weekly", "biweekly"].includes(frequency)) {
        return NextResponse.json(
            {error: "Valid frequency is required (daily, weekly, biweekly)"},
            {status: 400}
        )
    }

    const {error: upsertError} = await supabase.from("user_preferences").upsert(
        {user_id: user.id, categories, frequency, email, is_active: true}, 
        {onConflict: "user_id"}
    );

    if (upsertError) {
        console.error("Error saving preferences:", upsertError);

        return NextResponse.json(
            {error: "failed to save preferences"}, 
            {status: 500}
        );
    }

    // Schedule the first newsletter
    const now = new Date();
    let nextScheduleTime = new Date(now);

    switch (frequency) {
        case "daily":
            // Schedule for tomorrow at 9 AM
            nextScheduleTime.setDate(nextScheduleTime.getDate() + 1);
            break;
        case "weekly":
            // Schedule for next week at 9 AM
            nextScheduleTime.setDate(nextScheduleTime.getDate() + 7);
            break;
        case "biweekly":
            // Biweekly means twice a week (every 3.5 days)
            nextScheduleTime.setDate(nextScheduleTime.getDate() + 3);
            break;
        default:
            nextScheduleTime.setDate(nextScheduleTime.getDate() + 7);
    }

    nextScheduleTime.setHours(9, 0, 0, 0);

    // Ensure the scheduled time is at least 1 minute in the future
    const minFutureTime = new Date(now.getTime() + 60 * 1000);
    if (nextScheduleTime.getTime() < minFutureTime.getTime()) {
        nextScheduleTime.setDate(nextScheduleTime.getDate() + 1);
    }

    try {
        await inngest.send({
            name: "newsletter.schedule",
            data: {
                categories,
                email,
                frequency,
                userId: user.id
            },
            ts: nextScheduleTime.getTime()  // Inngest expects milliseconds
        });
    } catch (inngestError) {
        console.error("Error scheduling newsletter with Inngest:", inngestError);
        // Don't fail the request if Inngest scheduling fails
        // The user preferences are already saved
    }

        return NextResponse.json({
            success: true,
            message: "Preferences saved and added to table."
        })
    } catch (error) {
        console.error("Unexpected error in POST /api/user-preferences:", error);
        return NextResponse.json(
            {error: "Internal server error"},
            {status: 500}
        );
    }
}

export async function GET() {
    const supabase = await createClient();

    const {data: {user}} = await supabase.auth.getUser();

    if (!user) { 
        return NextResponse.json(
            {error: "you must be logged in to save preferences"}, 
            {status: 401}
        )
    }
    try {
        const {data: preferences, error: fetchError} = await supabase.from("user_preferences")
            .select("*")
            .eq("user_id", user.id)
            .single()

            if (fetchError) {
                console.error("Error getting preferences:", fetchError);

                return NextResponse.json(
                    {error: "failed to get preferences"}, 
                    {status: 500}
                );
            }

            return NextResponse.json(preferences);
    } catch (error) {
        console.error(error)
        return NextResponse.json(
            {error: "Internal Error"}, 
            {status: 500}
        );
    }


}

export async function PATCH(request: NextRequest) {
    const supabase = await createClient();

    const {data: {user}} = await supabase.auth.getUser();

    if (!user) { 
        return NextResponse.json(
            {error: "you must be logged in to save preferences"}, 
            {status: 401}
        )
    }
    try {
        const body = await request.json()
        const {is_active}= body;
        const {error: updateError} = await supabase
            .from("user_preferences")
            .update({is_active})
            .eq("user_id", user.id)

            if (updateError) {
                console.error("Error updating active status:", updateError);

                return NextResponse.json(
                    {error: "failed to update active status"}, 
                    {status: 500}
                );
            }
            if (!is_active) {
                await inngest.send({
                    name: "newsletter.schedule.deleted",
                    data: {
                        userId: user.id, 
                    }
                })
            }
            else {
                const {data: preferences, error} = await supabase
                    .from("user_preferences")
                    .select("categories, frequency, email")
                    .eq("user_id", user.id)
                    .single();

                    if (error || !preferences) {
                        throw new Error("user preferences not found");
                    }
                const now = new Date();
                let nextScheduleTime = new Date(now);

                switch (preferences.frequency) {
                    case "daily":
                        nextScheduleTime.setDate(nextScheduleTime.getDate() + 1);
                        break;
                     case "weekly":
                        nextScheduleTime.setDate(nextScheduleTime.getDate() + 7);
                        break;
                     case "biweekly":
                        // Biweekly means twice a week (every 3.5 days)
                        nextScheduleTime.setDate(nextScheduleTime.getDate() + 3);
                        break;
                    default:
                        nextScheduleTime.setDate(nextScheduleTime.getDate() + 7);
                }

                nextScheduleTime.setHours(9, 0, 0, 0);

                // Ensure the scheduled time is at least 1 minute in the future
                const minFutureTime = new Date(now.getTime() + 60 * 1000);
                if (nextScheduleTime.getTime() < minFutureTime.getTime()) {
                    nextScheduleTime.setDate(nextScheduleTime.getDate() + 1);
                }

                await inngest.send({
                    name: "newsletter.schedule",
                    data: {
                        categories: preferences.categories,
                        email: preferences.email,
                        frequency: preferences.frequency,
                        userId: user.id
                    },
                    ts: nextScheduleTime.getTime()  // Inngest expects milliseconds
                })
            }
            return NextResponse.json({success: true});
    } catch (error) {
        console.error(error)
        return NextResponse.json(
            {error: "Internal Error"}, 
            {status: 500}
        );
    }
}