I want you to build a CRM / operations system for an HVAC engineering company. The company is called FrostLine and they are a fairly typical UK HVAC business doing things like air conditioning, heating, ventilation, refrigeration, maintenance and repairs for commercial customers.

I've put a copy of their current public website in the `reference` folder which should give you a better idea of the company, what they do and the sorts of services they offer.

The idea is to replace a lot of the spreadsheets, shared mailboxes and separate systems they currently use with one application that can manage most of the day to day operation of the business.

It needs the normal CRM type stuff like customers and contacts, but customers can have multiple sites and obviously there will be equipment installed at those sites that we need to keep records of. We need to be able to see previous work that's been done for a customer/site/equipment etc.

A big part of it is service jobs. Customers phone or email when something isn't working, somebody in the office logs the call and then it needs to be scheduled to an engineer. They also do planned maintenance so there will be jobs that aren't breakdowns as well. Engineers need to be able to see their jobs and update what they've done, probably add notes/photos and parts used etc. It would be useful if the office can see a schedule/calendar of where everybody is and what availability they have.

They have service/maintenance contracts with some customers, different response times etc, although not every customer has a contract. They also quote for work, anything from repairs that an engineer identifies through to larger installation/replacement jobs. I imagine we'd want quotes and maybe some way of tracking them through accepted/rejected and then turning accepted work into jobs.

We probably need some basic stock/parts functionality as engineers carry common parts in their vans and there is also stock at the office, and they order things from suppliers when needed. Don't go crazy building an ERP system though. This is mainly an operations/CRM system rather than replacing their accounting package.

I'd like AI to be a useful part of the system rather than just having a chatbot bolted onto it. For example somebody in the office should ideally be able to ask it to do things in normal language like find a customer, create a job, work out who can attend it, schedule things, find information, maybe help with quotes etc. Basically if there are things an operations person would normally have to click through several screens to do, it would be nice if they could just ask the system and it handles it.

It should still have a good normal user interface though. I don't want the whole application to just be a chat window.

There will be different people using it. Office/service desk people, managers, engineers and probably sales/admin people. Engineers will mostly be using phones or tablets whereas the office will generally use desktop computers.

This isn't just a visual prototype. Build it as a proper working application with persistent data and a decent realistic UI. Put some realistic demo data in it as well so that we can actually use and test it without having to create everything manually first.

I'm not particularly bothered what technology you use. Choose whatever you think makes sense for this sort of application and is straightforward to run locally for now. We may deploy it properly later if it turns into something useful.

Have a look through the website/reference material and the repo first and then take it from there. You can make sensible decisions yourself rather than asking me about every little thing. If there's something important about the business that you genuinely need to know then ask me and I'll find out, but otherwise I'm happy for you to get on with it.

I'd rather get something working that we can try than spend ages writing a massive design document first.