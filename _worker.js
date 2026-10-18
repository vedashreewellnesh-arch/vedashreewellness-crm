export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS Headers for API calls
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper: JSON Response
    const json = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    };

    try {
      // -----------------------------------------------------------
      // SECTION 1: AUTH & AGENT MANAGEMENT (Admin Controls)
      // -----------------------------------------------------------
      if (path === "/api/auth/login" && method === "POST") {
        const { username, password } = await request.json();
        const user = await env.DB.prepare(
          "SELECT id, username, agent_name, role, status FROM agents WHERE username = ? AND password_hash = ?"
        ).bind(username, password).first();

        if (!user) return json({ success: false, message: "Galat ID ya Password" }, 401);
        if (user.status !== "active") return json({ success: false, message: "Aapka account deactivated hai" }, 403);

        return json({ success: true, user });
      }

      if (path === "/api/admin/agents" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT id, username, agent_name, role, status FROM agents").all();
        return json({ success: true, agents: results });
      }

      if (path === "/api/admin/agents/toggle" && method === "POST") {
        const { id, status } = await request.json();
        await env.DB.prepare("UPDATE agents SET status = ? WHERE id = ?").bind(status, id).run();
        return json({ success: true, message: "Status updated" });
      }

      // -----------------------------------------------------------
      // SECTION 2: LEADS (Child CRM Calling Queue & Distribution)
      // -----------------------------------------------------------
      if (path === "/api/leads/assign" && method === "POST") {
        const { leads, agent_id } = await request.json(); // array of {name, phone, city, state}
        for (const lead of leads) {
          await env.DB.prepare(
            "INSERT INTO leads (customer_name, phone_number, city, state, assigned_to) VALUES (?, ?, ?, ?, ?)"
          ).bind(lead.name || 'Customer', lead.phone, lead.city || '', lead.state || '', agent_id).run();
        }
        return json({ success: true, message: "Leads successfully assigned" });
      }

      if (path === "/api/agent/leads" && method === "GET") {
        const agent_id = url.searchParams.get("agent_id");
        const { results } = await env.DB.prepare(
          "SELECT * FROM leads WHERE assigned_to = ? AND current_status != 'converted' ORDER BY id ASC LIMIT 50"
        ).bind(agent_id).all();
        return json({ success: true, leads: results });
      }

      // -----------------------------------------------------------
      // SECTION 3: CALL LOGS & DISPOSITIONS
      // -----------------------------------------------------------
      if (path === "/api/calls/log" && method === "POST") {
        const { lead_id, agent_id, call_type, duration_seconds, disposition } = await request.json();
        
        await env.DB.prepare(
          "INSERT INTO call_logs (lead_id, agent_id, call_type, duration_seconds, disposition) VALUES (?, ?, ?, ?, ?)"
        ).bind(lead_id, agent_id, call_type || 'click_to_call', duration_seconds || 0, disposition).run();

        await env.DB.prepare(
          "UPDATE leads SET last_disposition = ?, total_calls_made = total_calls_made + 1, current_status = ? WHERE id = ?"
        ).bind(disposition, disposition === 'order_done' ? 'converted' : 'called', lead_id).run();

        return json({ success: true, message: "Disposition logged" });
      }

      // -----------------------------------------------------------
      // SECTION 4: ORDERS (Bookings & Deliveries)
      // -----------------------------------------------------------
      if (path === "/api/orders/create" && method === "POST") {
        const data = await request.json();
        await env.DB.prepare(`
          INSERT INTO orders (lead_id, agent_id, customer_name, customer_phone, shipping_address, pincode, medicine_details, order_amount, order_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          data.lead_id, data.agent_id, data.customer_name, data.customer_phone,
          data.shipping_address, data.pincode, data.medicine_details, data.order_amount, data.order_type || 'COD'
        ).run();

        await env.DB.prepare("UPDATE leads SET current_status = 'converted', last_disposition = 'order_done' WHERE id = ?").bind(data.lead_id).run();

        return json({ success: true, message: "Order placed successfully" });
      }

      // -----------------------------------------------------------
      // SECTION 5: PERFORMANCE METRICS & ADMIN DASHBOARD
      // -----------------------------------------------------------
      if (path === "/api/admin/metrics" && method === "GET") {
        const totalOrders = await env.DB.prepare("SELECT COUNT(*) as count, SUM(order_amount) as amount FROM orders").first();
        const deliveredOrders = await env.DB.prepare("SELECT COUNT(*) as count, SUM(order_amount) as amount FROM orders WHERE order_status = 'delivered'").first();
        const rtoOrders = await env.DB.prepare("SELECT COUNT(*) as count FROM orders WHERE order_status = 'rto'").first();
        const totalCalls = await env.DB.prepare("SELECT COUNT(*) as count FROM call_logs").first();

        return json({
          success: true,
          metrics: {
            total_orders: totalOrders.count || 0,
            total_order_amount: totalOrders.amount || 0,
            delivered_orders: deliveredOrders.count || 0,
            delivered_amount: deliveredOrders.amount || 0,
            rto_orders: rtoOrders.count || 0,
            total_calls: totalCalls.count || 0
          }
        });
      }

      // Fallback: Static Files
      return env.ASSETS.fetch(request);

    } catch (err) {
      return json({ success: false, error: err.message }, 500);
    }
  }
};
