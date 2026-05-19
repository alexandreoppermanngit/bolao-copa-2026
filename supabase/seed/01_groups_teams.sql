-- =====================================================================
-- SEED: 12 grupos + 48 seleções da Copa 2026
-- =====================================================================

insert into public.groups (code, display_order) values
  ('A',1),('B',2),('C',3),('D',4),('E',5),('F',6),
  ('G',7),('H',8),('I',9),('J',10),('K',11),('L',12)
on conflict (code) do nothing;

insert into public.teams (id, name, group_code) values
  -- Grupo A
  (1,'México','A'),(2,'África do Sul','A'),(3,'Coreia do Sul','A'),(4,'Rep. Tcheca','A'),
  -- Grupo B
  (5,'Canadá','B'),(6,'Bósnia','B'),(7,'Catar','B'),(8,'Suíça','B'),
  -- Grupo C
  (9,'Brasil','C'),(10,'Marrocos','C'),(11,'Haiti','C'),(12,'Escócia','C'),
  -- Grupo D
  (13,'Estados Unidos','D'),(14,'Paraguai','D'),(15,'Austrália','D'),(16,'Turquia','D'),
  -- Grupo E
  (17,'Alemanha','E'),(18,'Curaçao','E'),(19,'Costa do Marfim','E'),(20,'Equador','E'),
  -- Grupo F
  (21,'Holanda','F'),(22,'Japão','F'),(23,'Suécia','F'),(24,'Tunísia','F'),
  -- Grupo G
  (25,'Bélgica','G'),(26,'Egito','G'),(27,'Irã','G'),(28,'Nova Zelândia','G'),
  -- Grupo H
  (29,'Espanha','H'),(30,'Cabo Verde','H'),(31,'Arábia Saudita','H'),(32,'Uruguai','H'),
  -- Grupo I
  (33,'França','I'),(34,'Senegal','I'),(35,'Iraque','I'),(36,'Noruega','I'),
  -- Grupo J
  (37,'Argentina','J'),(38,'Argélia','J'),(39,'Áustria','J'),(40,'Jordânia','J'),
  -- Grupo K
  (41,'Portugal','K'),(42,'RD Congo','K'),(43,'Uzbequistão','K'),(44,'Colômbia','K'),
  -- Grupo L
  (45,'Inglaterra','L'),(46,'Croácia','L'),(47,'Gana','L'),(48,'Panamá','L')
on conflict (id) do nothing;

-- Reset sequence
select setval('public.teams_id_seq', 48, true);
