# ERD — Zahran Retail System

Entity-Relationship Diagram organized by module. View this file in any Markdown
renderer that supports Mermaid (GitHub, GitLab, VS Code, Obsidian, Notion…).

---

## 1 · RBAC & Users

```mermaid
erDiagram
    ROLES ||--o{ ROLE_PERMISSIONS : grants
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : granted
    ROLES ||--o{ USERS : has
    USERS ||--o{ USER_SESSIONS : opens
    USERS ||--o{ ACTIVITY_LOGS : performs
    USERS ||--o{ AUDIT_LOGS : changes

    ROLES {
        uuid id PK
        string code UK
        string name_ar
        bool is_system
    }
    PERMISSIONS {
        uuid id PK
        string code UK
        string module
    }
    USERS {
        uuid id PK
        string username UK
        string full_name
        uuid role_id FK
        uuid default_warehouse_id FK
        bool is_active
    }
```

## 2 · Catalog

```mermaid
erDiagram
    CATEGORIES ||--o{ CATEGORIES : parent
    CATEGORIES ||--o{ PRODUCTS : category
    BRANDS ||--o{ PRODUCTS : brand
    PRODUCTS ||--o{ PRODUCT_COLORS : has
    COLORS ||--o{ PRODUCT_COLORS : used
    PRODUCT_COLORS ||--o{ PRODUCT_IMAGES : gallery
    PRODUCTS ||--o{ PRODUCT_VARIANTS : sku
    COLORS ||--o{ PRODUCT_VARIANTS : color
    SIZES ||--o{ PRODUCT_VARIANTS : size

    PRODUCTS {
        uuid id PK
        string sku_prefix UK
        string name_ar
        enum product_type "shoe|bag|accessory"
        uuid category_id FK
        uuid brand_id FK
        numeric base_cost
        numeric base_price
    }
    PRODUCT_VARIANTS {
        uuid id PK
        uuid product_id FK
        uuid color_id FK
        uuid size_id FK
        string sku UK
        string barcode UK
        numeric cost_price
        numeric selling_price
    }
```

## 3 · Inventory

```mermaid
erDiagram
    WAREHOUSES ||--o{ STOCK : holds
    PRODUCT_VARIANTS ||--o{ STOCK : of
    WAREHOUSES ||--o{ STOCK_MOVEMENTS : affects
    PRODUCT_VARIANTS ||--o{ STOCK_MOVEMENTS : variant
    WAREHOUSES ||--o{ STOCK_TRANSFERS : from
    WAREHOUSES ||--o{ STOCK_TRANSFERS : to
    STOCK_TRANSFERS ||--o{ STOCK_TRANSFER_ITEMS : lines
    WAREHOUSES ||--o{ STOCK_ADJUSTMENTS : in
    STOCK_ADJUSTMENTS ||--o{ STOCK_ADJUSTMENT_ITEMS : lines
    WAREHOUSES ||--o{ INVENTORY_COUNTS : counts
    INVENTORY_COUNTS ||--o{ INVENTORY_COUNT_ITEMS : lines

    STOCK {
        uuid id PK
        uuid variant_id FK
        uuid warehouse_id FK
        int quantity_on_hand
        int quantity_reserved
        int reorder_point
    }
    STOCK_MOVEMENTS {
        bigint id PK
        enum movement_type
        enum direction
        int quantity
        enum reference_type
        uuid reference_id
    }
```

## 4 · Customers & Suppliers & Purchases

```mermaid
erDiagram
    CUSTOMERS ||--o{ CUSTOMER_LOYALTY_TRANSACTIONS : earns
    SUPPLIERS ||--o{ PURCHASES : issues
    SUPPLIERS ||--o{ SUPPLIER_LEDGER : runs
    PURCHASES ||--o{ PURCHASE_ITEMS : lines
    PURCHASES ||--o{ PURCHASE_PAYMENTS : paid
    PRODUCT_VARIANTS ||--o{ PURCHASE_ITEMS : variant
    WAREHOUSES ||--o{ PURCHASES : receives

    CUSTOMERS {
        uuid id PK
        string customer_no UK
        string full_name
        string phone UK
        int loyalty_points
        string loyalty_tier
        numeric total_spent
    }
    SUPPLIERS {
        uuid id PK
        string name
        string phone
        numeric current_balance
    }
```

## 5 · POS / Invoices / Discounts / Coupons

```mermaid
erDiagram
    WAREHOUSES    ||--o{ INVOICES : at
    CUSTOMERS     ||--o{ INVOICES : buys
    USERS         ||--o{ INVOICES : cashier
    USERS         ||--o{ INVOICES : salesperson
    SHIFTS        ||--o{ INVOICES : during
    INVOICES      ||--o{ INVOICE_ITEMS : lines
    INVOICES      ||--o{ INVOICE_PAYMENTS : paid
    PRODUCT_VARIANTS ||--o{ INVOICE_ITEMS : sku
    DISCOUNTS     ||--o{ DISCOUNT_USAGES : applied
    INVOICES      ||--o{ DISCOUNT_USAGES : on
    INVOICE_ITEMS ||--o{ DISCOUNT_USAGES : on
    COUPONS       ||--o{ COUPON_USAGES : redeemed
    INVOICES      ||--o{ COUPON_USAGES : on
    CUSTOMERS     ||--o{ COUPON_USAGES : by

    INVOICES {
        uuid id PK
        string invoice_no UK
        enum status "draft|completed|paid|..."
        uuid warehouse_id FK
        uuid customer_id FK
        uuid cashier_id FK
        uuid salesperson_id FK
        uuid shift_id FK
        uuid reservation_id FK
        numeric subtotal
        numeric grand_total
        numeric paid_amount
        numeric cogs_total
        numeric gross_profit
        string offline_id
    }
    INVOICE_ITEMS {
        uuid id PK
        uuid invoice_id FK
        uuid variant_id FK
        int quantity
        numeric unit_cost
        numeric unit_price
        numeric discount_amount
        numeric line_total
    }
    COUPONS {
        uuid id PK
        string code UK
        enum coupon_type
        numeric value
        timestamp expires_at
        int max_uses_total
    }
```

## 6 · Reservations 🔥 (Partial Payment)

```mermaid
erDiagram
    CUSTOMERS  ||--o{ RESERVATIONS : makes
    WAREHOUSES ||--o{ RESERVATIONS : at
    RESERVATIONS ||--o{ RESERVATION_ITEMS : holds
    PRODUCT_VARIANTS ||--o{ RESERVATION_ITEMS : variant
    RESERVATIONS ||--o{ RESERVATION_PAYMENTS : deposits
    RESERVATIONS ||--o{ RESERVATION_REFUNDS : refunds
    RESERVATIONS ||--o| INVOICES : convertsTo

    RESERVATIONS {
        uuid id PK
        string reservation_no UK
        uuid customer_id FK
        uuid warehouse_id FK
        enum status "active|completed|cancelled|expired"
        numeric total_amount
        numeric paid_amount
        numeric remaining_amount
        timestamp expires_at
        timestamp reserved_at
        uuid converted_invoice_id FK
    }
    RESERVATION_ITEMS {
        uuid id PK
        uuid reservation_id FK
        uuid variant_id FK
        int quantity
        numeric unit_price
        numeric line_total
    }
    RESERVATION_PAYMENTS {
        uuid id PK
        uuid reservation_id FK
        enum kind "deposit|installment|final"
        enum payment_method
        numeric amount
    }
    RESERVATION_REFUNDS {
        uuid id PK
        uuid reservation_id FK
        numeric gross_amount
        numeric fee_amount
        numeric net_refund_amount
    }
```

## 7 · Returns & Exchanges

```mermaid
erDiagram
    INVOICES ||--o{ RETURNS : original
    RETURNS  ||--o{ RETURN_ITEMS : lines
    PRODUCT_VARIANTS ||--o{ RETURN_ITEMS : variant
    INVOICES ||--o{ EXCHANGES : original
    EXCHANGES ||--o{ EXCHANGE_ITEMS : lines
    EXCHANGES ||--o| INVOICES : newInvoice

    RETURNS {
        uuid id PK
        string return_no UK
        enum status "pending|approved|refunded|rejected"
        enum reason
        numeric total_refund
        numeric net_refund
    }
    EXCHANGES {
        uuid id PK
        string exchange_no UK
        numeric returned_value
        numeric new_items_value
        numeric price_difference
    }
```

## 8 · Accounting & Shifts

```mermaid
erDiagram
    WAREHOUSES  ||--o{ CASHBOXES : in
    CASHBOXES   ||--o{ CASHBOX_TRANSACTIONS : tracks
    CASHBOXES   ||--o{ SHIFTS : opens
    USERS       ||--o{ SHIFTS : operates
    SHIFTS      ||--o{ INVOICES : during
    EXPENSE_CATEGORIES ||--o{ EXPENSES : bucket
    WAREHOUSES  ||--o{ EXPENSES : at
    USERS       ||--o{ SALESPERSON_COMMISSIONS : earns
    INVOICES    ||--o{ SALESPERSON_COMMISSIONS : basis

    SHIFTS {
        uuid id PK
        string shift_no UK
        enum status "open|closed"
        numeric opening_balance
        numeric expected_closing
        numeric actual_closing
        numeric difference
    }
    EXPENSES {
        uuid id PK
        string expense_no UK
        uuid category_id FK
        numeric amount
        enum payment_method
    }
```

## 9 · Alerts / Imports / Offline Sync

```mermaid
erDiagram
    ALERT_RULES ||--o{ ALERTS : emits
    EXCEL_IMPORTS ||--o{ EXCEL_IMPORT_ERRORS : errors
    USERS ||--o{ EXCEL_IMPORTS : uploads
    USERS ||--o{ OFFLINE_SYNC_QUEUE : pushes

    ALERTS {
        bigint id PK
        enum alert_type
        enum severity
        string title
        bool is_read
        bool is_resolved
        enum entity
        uuid entity_id
    }
    OFFLINE_SYNC_QUEUE {
        uuid id PK
        string client_id
        string offline_id
        enum entity
        char operation
        jsonb payload
        enum state "pending|synced|conflict|failed"
    }
    EXCEL_IMPORTS {
        uuid id PK
        enum status
        int total_rows
        int valid_rows
        int invalid_rows
    }
```

## 10 · Cash Desk (Customer & Supplier Payments) 💰

```mermaid
erDiagram
    CUSTOMERS ||--o{ CUSTOMER_PAYMENTS : receives_from
    CASHBOXES ||--o{ CUSTOMER_PAYMENTS : into
    WAREHOUSES ||--o{ CUSTOMER_PAYMENTS : at
    SHIFTS ||--o{ CUSTOMER_PAYMENTS : during
    USERS ||--o{ CUSTOMER_PAYMENTS : received_by
    CUSTOMER_PAYMENTS ||--o{ CUSTOMER_PAYMENT_ALLOCATIONS : splits
    INVOICES ||--o{ CUSTOMER_PAYMENT_ALLOCATIONS : settles
    CUSTOMERS ||--o{ CUSTOMER_LEDGER : statement

    SUPPLIERS ||--o{ SUPPLIER_PAYMENTS : paid_to
    CASHBOXES ||--o{ SUPPLIER_PAYMENTS : from
    WAREHOUSES ||--o{ SUPPLIER_PAYMENTS : at
    SHIFTS ||--o{ SUPPLIER_PAYMENTS : during
    USERS ||--o{ SUPPLIER_PAYMENTS : paid_by
    SUPPLIER_PAYMENTS ||--o{ SUPPLIER_PAYMENT_ALLOCATIONS : splits
    PURCHASES ||--o{ SUPPLIER_PAYMENT_ALLOCATIONS : settles

    CUSTOMER_PAYMENTS {
        uuid id PK
        string payment_no UK "CR-YYYY-NNNNNN"
        uuid customer_id FK
        uuid cashbox_id FK
        enum payment_method
        enum kind "deposit|invoice_settlement|advance|refund_out|opening_balance|other"
        numeric amount
        numeric allocated_amount
        numeric unallocated_amount
        bool is_void
    }
    CUSTOMER_PAYMENT_ALLOCATIONS {
        uuid id PK
        uuid payment_id FK
        uuid invoice_id FK
        numeric allocated_amount
    }
    CUSTOMER_LEDGER {
        bigint id PK
        uuid customer_id FK
        enum direction "in|out"
        numeric amount
        numeric balance_after
        enum reference_type
        uuid reference_id
    }
    SUPPLIER_PAYMENTS {
        uuid id PK
        string payment_no UK "CP-YYYY-NNNNNN"
        uuid supplier_id FK
        uuid cashbox_id FK
        enum payment_method
        enum kind "purchase_settlement|advance|refund_in|opening_balance|other"
        numeric amount
        numeric allocated_amount
        numeric unallocated_amount
        bool is_void
    }
    SUPPLIER_PAYMENT_ALLOCATIONS {
        uuid id PK
        uuid payment_id FK
        uuid purchase_id FK
        numeric allocated_amount
    }
```

---

## Legend
- PK = Primary Key
- FK = Foreign Key
- UK = Unique Key
- `||--o{` = one-to-many
- `||--o|` = one-to-one (optional)
