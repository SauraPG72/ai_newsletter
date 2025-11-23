import { fetchArticles } from "@/lib/news";
import { inngest } from "../client";
import { marked } from "marked";
import { sendEmail } from "@/lib/email";
import { createClient } from "@/lib/client";


export default inngest.createFunction(
        {id: "newsletter/scheduled", cancelOn: [{
            event: "newsletter.schedule.deleted",
            if : "event.data.userId == async.data.userId"
        }]} , 
        {event: "newsletter.schedule"}, 
        async({event, step, runId}) => {

            const isUserActive = await step.run("check-user-status", async () => {
                const supabase = await createClient()

                const {data, error} = await supabase
                    .from("user_preferences")
                    .select("is_active")
                    .eq("user_id", event.data.userId)
                    .single();

                if (error) {
                    return false
                }

                return data.is_active || false;
            })

            if (!isUserActive) {
                return {}
            }

            // Fetch articles per category
            const categories = event.data.categories; 
            const allArticles = await step.run("fetch-news", async () => {

                return fetchArticles(categories)
            });

            // Generate AI Summary. 
            const summary = await step.ai.infer("summarize-news", {
                model: step.ai.models.openai({model: "gpt-4o"}), 
                body: {
                    messages: [
                        {
                            role: "system", 
                            content: `You are an expert newsletter editor creating a personalised newsletter 
                            Write a concise, engaging summary that:
                            - Highlights the most important stories, 
                            - Provided context and insights 
                            - Uses a friendly, conversational tone, 
                            - Is well structured with clear sections. 
                            - Keeps the reader informed and engaged 
                            - Format the response as a proper newsletter with a title and organised content. 
                            - Make it email friendly with clear sections and engaging subject lines. 
                            `
                        }, 
                        {
                            role: "user", 
                            content: `Create a newsletter summary for these articles from the past week. 
                            Categories reqested: ${categories.join(", ")}

                            Articles: 
                            ${allArticles.map((article: any, idx: number) => `${idx + 1}. ${article.title}\n 
                                ${article.title} \n
                                ${article.description} \n 
                                Source: ${article.description}\n`).join("/n")}
                            
                            `
                        }
                    ]
                }
            });

            const newsletterContent = summary.choices[0].message.content 

            if (!newsletterContent) {
                throw new Error("failed to generate newsletter content");
            }

            const htmlResult = await marked(newsletterContent);

            await step.run("send-email", async () => {
                await sendEmail(
                    event.data.email, 
                    event.data.categories.join(", "), 
                    allArticles.length,
                    htmlResult 
                );
            });

            await step.run("schedule-next" , async () => {
                const now = new Date();
                let nextScheduleTime = new Date(now);

                switch (event.data.frequency) {
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
                        categories,
                        email: event.data.email,
                        frequency: event.data.frequency,
                        userId: event.data.userId
                    },
                    ts: nextScheduleTime.getTime()  // Inngest expects milliseconds
                })
            })

            return {newsletter: htmlResult, articleCount: allArticles.length, nextScheduled: true};

        }    
    )